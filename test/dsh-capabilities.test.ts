import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SkillRegistry, { type SkillCandidate } from '@deepseek-ai/dsh-skill'
import { DshCapabilities, type DshCapabilityInvocation } from '../src/dsh-capabilities.ts'
import { dynamicPresenterDefinition } from '../src/presenters.ts'
import { resolveDirectUserPrompt } from '../src/adapter.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  const session = ctx.sessions.create(SessionId('capability-test'))
  const agent = { id: session.id, session, ctx } as Agent
  const abort = new AbortController()
  let active: DshCapabilityInvocation | undefined = { agent, cursor: { turn: 1, step: 1 }, signal: abort.signal }
  const bridge = new DshCapabilities(ctx, () => active, { maxResultBytes: 1024 })
  return { ctx, session, agent, abort, bridge, change: (value: typeof active) => { active = value }, async dispose() { abort.abort(); await bridge.dispose(); await ctx.fiber.dispose() } }
}

function echo(execute = vi.fn(async (args: { text?: string }) => args.text ?? 'ok')) {
  return defineTool({ name: 'mcp__fixture__echo', description: 'Echo', parameters: { text: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute })
}

it('discovers current DSH connectors without exposing Claude presentation mirrors and uses the DSH execution pipeline', async ({ onTestFinished }) => {
  const f = await fixture(); onTestFinished(() => f.dispose())
  const execute = vi.fn(async (args: { text?: string }) => args.text ?? 'ok')
  f.ctx.effect(() => f.ctx.tools.register(echo(execute)))
  f.ctx.effect(() => f.ctx.tools.register(dynamicPresenterDefinition('mcp__native__mirror')))
  const list = await f.bridge.invoke('list_connectors', {})
  expect(JSON.parse((list.content[0] as { text: string }).text)).toEqual([{
    name: 'mcp__fixture__echo', description: 'Echo', parameters: { type: 'object', properties: { text: { type: 'string' } } },
  }])
  const result = await f.bridge.invoke('call_connector', { name: 'mcp__fixture__echo', arguments: { text: 'Connected through DSH' } })
  expect(result).toEqual({ content: [{ type: 'text', text: 'Connected through DSH' }], isError: false })
  expect(execute).toHaveBeenCalledOnce()
  const recorded = f.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)!
  expect(recorded.data.message.content[0].content).toEqual(result.content)
  f.ctx.on('tools/pre-execute', (_exec, _next) => ({ kind: 'deny', reason: 'denied by policy' }))
  expect((await f.bridge.invoke('call_connector', { name: 'mcp__fixture__echo' })).isError).toBe(true)
  expect(execute).toHaveBeenCalledOnce()
  await expect(f.bridge.invoke('call_connector', { name: 'mcp__native__mirror' })).rejects.toThrow('unavailable')
})

it('loads only model-invocable skills from the active DSH registry and logs their complete instructions', async ({ onTestFinished }) => {
  const f = await fixture(); onTestFinished(() => f.dispose())
  const entries: SkillCandidate[] = ['review', 'manual-only'].map(name => ({ name, description: name, invocation: { userInvocable: true, modelInvocable: name !== 'manual-only' }, provider: 'fixture', source: 'fixture', rank: 0, locator: {} }))
  const list = vi.fn(async () => entries)
  f.ctx.effect(() => f.ctx.skills.registerProvider(() => ({ name: 'fixture', list, async get(candidate) { return { ...candidate, content: 'Inspect changes and report findings.' } } })))
  expect(JSON.parse((await f.bridge.invoke('list_skills', {})).content[0]!.text!)).toEqual([{ name: 'review', description: 'review' }])
  expect(list.mock.calls[0]?.[0]?.scope).toBe(f.agent)
  const result = await f.bridge.invoke('load_skill', { name: 'review' })
  expect(result.isError).toBe(false)
  expect(result.content[0]!.text).toContain('Inspect changes and report findings.')
  expect((await f.bridge.invoke('load_skill', { name: 'manual-only' })).isError).toBe(true)
  expect(f.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => ({ isError: event.data.message.content[0].isError, content: event.data.message.content[0].content }))).toMatchSnapshot()
  f.ctx.provide('agents', {})
  await f.ctx.plugin(toolSkill)
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/manual-only check changes' }] })
  const decision = await agentEvents(f.ctx, f.agent).waterfall('agent/pre-step', { messages: [human], turn: 1, step: 1, signal: f.abort.signal }, () => Promise.resolve({ kind: 'enter' as const, messages: [human] }))
  if (decision.kind !== 'enter') throw new Error('Skill admission failed')
  for (const message of decision.messages) f.session.append('user/message', message, { surfaceOp: 'append' })
  const prompt = await resolveDirectUserPrompt(decision.messages, { imageLimits: { maxImagesPerMessage: 1 }, readImage: async () => { throw new Error('No image') } } as never)
  expect(prompt).toContain('Use the DSH skill manual-only for this request. check changes')
  expect(prompt).toContain('Inspect changes and report findings.')
  expect(prompt).not.toContain('<available_skills>')
  expect(human.content[0]).toEqual({ type: 'text', text: '/manual-only check changes' })
})

it('does not dispatch queued work after cancellation or a turn change', async ({ onTestFinished }) => {
  const f = await fixture(); onTestFinished(() => f.dispose())
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const execute = vi.fn(async () => { entered(); await gate; return 'finished' })
  f.ctx.effect(() => f.ctx.tools.register(echo(execute)))
  const first = f.bridge.invoke('call_connector', { name: 'mcp__fixture__echo' })
  await ready
  const second = f.bridge.invoke('call_connector', { name: 'mcp__fixture__echo' })
  const refused = expect(second).rejects.toThrow('outlived')
  f.change({ agent: f.agent, cursor: { turn: 2, step: 1 }, signal: f.abort.signal })
  release(); await first; await refused
  expect(execute).toHaveBeenCalledOnce()
  f.abort.abort()
  await expect(f.bridge.invoke('list_connectors', {})).rejects.toThrow()
  expect(execute).toHaveBeenCalledOnce()
})

it('reports oversized results explicitly and closes the one query-owned SDK MCP server', async ({ onTestFinished }) => {
  const f = await fixture(); onTestFinished(() => f.dispose())
  f.ctx.effect(() => f.ctx.tools.register(echo()))
  const result = await f.bridge.invoke('call_connector', { name: 'mcp__fixture__echo', arguments: { text: 'x'.repeat(2048) } })
  expect(result.isError).toBe(true)
  expect(result.content[0]!.text).toContain('limits')
  expect(result.content[0]!.text).not.toContain('xxxx')
  const server = f.bridge.server()
  expect(server.type).toBe('sdk')
  expect(f.bridge.server()).toBe(server)
  f.change(undefined)
  await expect(f.bridge.invoke('list_connectors', {})).rejects.toThrow('active turn')
})

it('exposes callable DSH operations through the official SDK MCP transport', async ({ onTestFinished }) => {
  const f = await fixture(); onTestFinished(() => f.dispose())
  f.ctx.effect(() => f.ctx.tools.register(echo()))
  const server = f.bridge.server()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'fixture', version: '1' })
  onTestFinished(() => client.close())
  await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)])
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['list_skills', 'load_skill', 'list_connectors', 'call_connector', 'list_resources', 'read_resource'])
  expect(await client.callTool({ name: 'call_connector', arguments: { name: 'mcp__fixture__echo', arguments: { text: 'MCP → DSH' } } })).toMatchObject({ content: [{ type: 'text', text: 'MCP → DSH' }], isError: false })
  expect((await client.callTool({ name: 'call_connector', arguments: { name: 'mcp__fixture__echo', arguments: { text: 42 } } })).isError).toBe(true)
})

it('uses the optional Kit resource tools with the consuming Agent scope and reports removal', async ({ onTestFinished }) => {
  const f = await fixture(); onTestFinished(() => f.dispose())
  await expect(f.bridge.invoke('read_resource', { arguments: { uri: 'dsh-resource://workbench/session/source' } })).rejects.toThrow('Workbench Kit')
  const execute = vi.fn(async (_args, exec) => { expect(exec.agent).toBe(f.agent); return 'Version-pinned resource body' })
  const remove = f.ctx.tools.register(defineTool({ name: 'workbench_resource_read', description: 'Read resource', parameters: { uri: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute }))
  expect(await f.bridge.invoke('read_resource', { arguments: { uri: 'dsh-resource://workbench/session/source' } })).toEqual({ content: [{ type: 'text', text: 'Version-pinned resource body' }], isError: false })
  remove()
  await expect(f.bridge.invoke('read_resource', { arguments: { uri: 'dsh-resource://workbench/session/source' } })).rejects.toThrow('Workbench Kit')
})
