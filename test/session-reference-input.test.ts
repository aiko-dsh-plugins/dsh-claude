import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createMessage, createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionReferenceResolver, { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import { ClaudeCodeAdapter } from '../src/adapter.ts'
import type { ClaudeSupervisor, ClaudeTurnRequest } from '../src/supervisor.ts'

/** Exact live-session reads use DSH's implementation; this fixture has no search backend. */
class LiveSessionQuery extends SessionQueryEngine {
  override searchSessions(): ReturnType<SessionQueryEngine['searchSessions']> {
    throw new Error('Search is outside reference admission')
  }
  override searchEvents(): ReturnType<SessionQueryEngine['searchEvents']> {
    throw new Error('Search is outside reference admission')
  }
}

it('delivers native mention admission to Claude from logged context and leaves the next turn clean', async ({ onTestFinished }) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LiveSessionQuery)
  await ctx.plugin(SessionReferenceResolver, { maxReferenceBytes: 65536 })
  const source = ctx.sessions.create(SessionId('reference-source'))
  source.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: '项目代号是什么？' }],
  }), { surfaceOp: 'append' })
  source.append('assistant/message', {
    turn: 1, step: 1, stream: [], message: createMessage({
      role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: '项目代号是 ORBIT-42。' }],
    }),
  }, { surfaceOp: 'append' })
  source.append('user/message', createUserMessage({
    source: { kind: 'plugin', plugin: 'fixture', form: 'notice', summary: 'Internal context' },
    content: [{ type: 'text', text: 'INJECTED_CONTEXT' }],
  }), { surfaceOp: 'append' })
  const target = ctx.sessions.create(SessionId('reference-target'))
  // The adapter and pre-step resolver only need this Agent's identity, options and Session.
  const agent = { id: target.id, session: target, options: {} } as Agent
  const human = createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: `读取 ${formatSessionReferenceMention({ sessionId: source.id, label: '项目说明' })}，告诉我项目代号。` }],
  })
  const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages: [human], turn: 1, step: 1, signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [human] }))
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') throw new Error('Reference admission rejected')
  expect(decision.messages.map(message => message.source.kind)).toEqual(['user', 'session-reference'])
  expect(decision.messages[0]?.content).toEqual([{ type: 'text', text: '读取 @项目说明，告诉我项目代号。' }])
  expect(decision.messages[0]?.id).toBe(human.id)
  for (const message of decision.messages) target.append('user/message', message, { surfaceOp: 'append' })

  const prompts: unknown[] = []
  // Only the engine transport is replaced; native admission, projection and the Claude adapter run normally.
  const supervisor = {
    contextWindow: () => undefined,
    async *runTurn(request: ClaudeTurnRequest) {
      prompts.push(request.prompt)
      yield { type: 'complete' as const, text: 'ORBIT-42' }
    },
  } as unknown as ClaudeSupervisor
  const adapter = new ClaudeCodeAdapter(supervisor, {
    currentInitiator: () => agent, get: () => agent,
  }, {
    imageLimits: { maxImageBytes: 10, maxImagesPerMessage: 1, maxMessageImageBytes: 10, maxImagePixels: 1, mediaTypes: ['image/png'] },
    readImage: async () => { throw new Error('Text-only reference must not read attachments') },
  }, () => 'claude')
  const surface = await ctx.sessionQuery.readSurface(target.id)
  const messages: Message[] = surface.events.flatMap(event => event.type === 'user/message' ? [event.data] : [])
  for await (const _chunk of adapter.stream({ provider: 'claude', model: 'default', sessionId: target.id, messages })) { /* drain */ }
  expect(prompts[0]).toMatchSnapshot()
  expect(prompts[0]).not.toContain('PRIVATE_REASONING')
  expect(prompts[0]).not.toContain('INJECTED_CONTEXT')
  expect(prompts[0]).toContain('ORBIT-42')
  for await (const _chunk of adapter.stream({
    provider: 'claude', model: 'default', sessionId: target.id,
    messages: [...messages, createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] })],
  })) { /* drain */ }
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toBe('继续')
})
