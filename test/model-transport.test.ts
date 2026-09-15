import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi, onTestFinished } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { DshCapabilityInvocation } from '../src/dsh-capabilities.ts'
import { isDshProviderDispatch, modelTransport } from '../src/model-transport.ts'
import { listDshModelOptions, resolveDshModelConnection } from '../src/dsh-models.ts'
import { modelSettingsFrom } from '../src/model-settings.ts'
import { ModelJournal } from '../src/model-journal.ts'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

const limits = { maxRequestBytes: 65536, maxResponseBytes: 65536, requestTimeoutMs: 5000 }
const toolResponse: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: 'Inspect a file.' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Inspect a file.' } },
  { type: 'tool-call-delta', index: 1, id: ToolCallId('call_read'), name: 'Read', argumentsDelta: '{"file_path":' },
  { type: 'tool-call-delta', index: 1, id: ToolCallId('call_read'), argumentsDelta: '"README.md"}' },
  { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('call_read'), name: 'Read', arguments: '{"file_path":"README.md"}' } },
  { type: 'usage', usage: { inputTokens: 50, outputTokens: 12, cacheReadTokens: 5 } },
  { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { response: { fixture: 'signed-response' }, blocks: [{ fixture: 'reasoning-replay' }, null] } },
]

async function setup(chunks: StreamChunk[] = toolResponse) {
  const root = await mkdtemp(join(tmpdir(), 'aiko-model-transport-'))
  const abort = new AbortController()
  const agent = { id: 'transport-session' } as DshCapabilityInvocation['agent']
  let current: DshCapabilityInvocation | undefined = { agent, cursor: { turn: 1, step: 1 }, signal: abort.signal }
  const stream = vi.fn(async function* (options: GenerateOptions) { expect(isDshProviderDispatch()).toBe(true); for (const chunk of chunks) yield chunk })
  const ctx = { llm: { stream, resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }] } }) }, attachments: {} } as unknown as Context
  const open = modelTransport(ctx, { 'aiko-dsh-sonnet': { provider: 'fixture-openai', model: 'code-model' }, 'aiko-dsh-haiku': { provider: 'fixture-other', model: 'fast-model' } }, limits, root)
  const handle = await open(() => current)
  const client = new Anthropic({ baseURL: handle.env.ANTHROPIC_BASE_URL, apiKey: handle.env.ANTHROPIC_API_KEY, maxRetries: 0 })
  let disposed = false
  onTestFinished(async () => { abort.abort(); if (!disposed) await handle.dispose(); await rm(root, { recursive: true, force: true }) })
  return { client, stream, ctx, root, abort, handle, change(value: typeof current) { current = value }, async dispose() { await handle.dispose(); disposed = true } }
}

it('serves a real Anthropic SDK stream through DSH, preserves tool arguments and routes role aliases independently', async () => {
  const f = await setup()
  const request = { model: 'aiko-dsh-sonnet', max_tokens: 1024, messages: [{ role: 'user' as const, content: 'Read the README' }], tools: [{ name: 'Read', input_schema: { type: 'object' as const, properties: { file_path: { type: 'string' } } } }] }
  const first = await f.client.messages.stream(request).finalMessage()
  expect(first.stop_reason).toBe('tool_use')
  expect(first.content).toEqual([{ type: 'thinking', thinking: 'Inspect a file.', signature: '' }, { type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'README.md' } }])
  expect(first.usage).toMatchObject({ input_tokens: 50, output_tokens: 12, cache_read_input_tokens: 5 })
  expect(f.stream.mock.calls[0]![0]).toMatchObject({ provider: 'fixture-openai', model: 'code-model', tools: [{ name: 'Read' }] })
  await f.client.messages.create({ ...request, messages: [...request.messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'Project details.' }] }] })
  const second = f.stream.mock.calls[1]![0]
  expect(second.messages[1]!.source).toMatchObject({ kind: 'model', replayState: { response: { fixture: 'signed-response' } } })
  expect(second.messages.map(message => message.source.kind)).toEqual(['user', 'model', 'tool'])
  expect(second.messages[2]!.content).toEqual([{ type: 'tool-result', toolCallId: 'call_read', content: [{ type: 'text', text: 'Project details.' }], isError: false }])
  await f.client.messages.create({ ...request, model: 'aiko-dsh-haiku' })
  expect(f.stream.mock.calls[2]![0]).toMatchObject({ provider: 'fixture-other', model: 'fast-model' })
  const dirs = await readdir(f.root)
  const files = await readdir(join(f.root, dirs[0]!))
  expect(files.filter(name => name.endsWith('.request.json'))).toHaveLength(3)
  const recorded = JSON.parse(await readFile(join(f.root, dirs[0]!, files.find(name => name.endsWith('.request.json'))!), 'utf8'))
  expect(recorded.options.tools).toEqual(request.tools.map(tool => ({ name: tool.name, description: '', parameters: tool.input_schema })))
  expect(JSON.stringify(recorded)).not.toContain(f.handle.env.ANTHROPIC_API_KEY)
})

it('streams the first text delta before waiting for the provider to finish', async () => {
  const f = await setup([])
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  onTestFinished(() => release())
  f.stream.mockImplementation(async function* () {
    yield { type: 'text-delta', index: 0, text: 'first' }
    await gate
    yield { type: 'text-delta', index: 0, text: ' second' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const stream = f.client.messages.stream({ model: 'aiko-dsh-sonnet', max_tokens: 30, messages: [{ role: 'user', content: 'Hello' }] })
  const early = new Promise<void>(resolve => stream.on('text', text => { if (text === 'first') resolve() }))
  await early
  release()
  expect((await stream.finalMessage()).content).toEqual([{ type: 'text', text: 'first second' }])
})

it('rejects unauthenticated, cross-origin, unknown model and unsupported content before provider dispatch', async () => {
  const f = await setup()
  const url = `${f.handle.env.ANTHROPIC_BASE_URL}/v1/messages`
  const body = { model: 'aiko-dsh-sonnet', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] }
  const send = (data: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) })
  expect((await send(body)).status).toBe(401)
  expect((await send(body, { 'x-api-key': f.handle.env.ANTHROPIC_API_KEY!, Origin: 'https://example.com' })).status).toBe(401)
  const auth = { 'x-api-key': f.handle.env.ANTHROPIC_API_KEY! }
  expect((await send({ ...body, model: 'arbitrary' }, auth)).status).toBe(400)
  expect((await send({ ...body, messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }] }, auth)).status).toBe(400)
  expect((await send({ ...body, tool_choice: { type: 'any' } }, auth)).status).toBe(400)
  expect((await send({ ...body, messages: [{ role: 'user', content: 'x'.repeat(70000) }] }, auth)).status).toBe(413)
  f.change(undefined)
  expect((await send(body, auth)).status).toBe(409)
  expect(f.stream).not.toHaveBeenCalled()
  await f.dispose()
  await expect(send(body, auth)).rejects.toThrow()
})

it('offers all configured provider models and maps mixed provider roles without reading credentials', async () => {
  const info = vi.fn(async (provider: string, id: string) => ({ provider, id, name: id }))
  const ctx = { llm: { listProviders: () => [{ id: 'deepseek-official' }, { id: 'other' }, { id: 'claude' }], listModels: async (provider: string) => [{ provider, id: 'model', name: provider }], resolveModelInfo: info } } as unknown as Context
  expect((await listDshModelOptions(ctx)).map(option => JSON.parse(option.value).provider)).toEqual(['deepseek-official', 'other'])
  const settings = modelSettingsFrom({ modelHaiku: JSON.stringify({ provider: 'other', model: 'fast' }), modelSonnet: JSON.stringify({ provider: 'deepseek-official', model: 'main' }), modelOpus: JSON.stringify({ provider: 'other', model: 'strong' }) })
  const connection = await resolveDshModelConnection(ctx, 'claude', 'sonnet', settings, limits)
  expect(connection?.openTransport).toBeTypeOf('function')
  expect(connection?.env).toMatchObject({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'aiko-dsh-haiku' })
  expect(info).toHaveBeenCalledWith('other', 'fast')
})

it('cancels an active provider request when its query owner aborts', async () => {
  const f = await setup([])
  let entered!: () => void
  let observed!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const cancelled = new Promise<void>(resolve => { observed = resolve })
  f.stream.mockImplementation(async function* (options) {
    entered()
    await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => { observed(); resolve() }, { once: true }))
    options.signal!.throwIfAborted()
  })
  const operation = f.client.messages.create({ model: 'aiko-dsh-sonnet', max_tokens: 10, messages: [{ role: 'user', content: 'Wait' }] })
  const rejected = expect(operation).rejects.toThrow()
  await started
  f.abort.abort()
  await cancelled
  await rejected
})

it('does not acknowledge an incomplete provider stream as a completed answer', async () => {
  const f = await setup([{ type: 'text-delta', index: 0, text: 'partial' }])
  await expect(f.client.messages.stream({ model: 'aiko-dsh-sonnet', max_tokens: 10, messages: [{ role: 'user', content: 'Hello' }] }).finalMessage()).rejects.toThrow()
})

it('restores exact-response provenance across journal instances and keeps credential-like values out of audit files', async () => {
  const f = await setup([])
  const selected = { provider: 'fixture', model: 'one' }
  const content = [{ type: 'text' as const, text: 'answer' }]
  const writer = new ModelJournal('journal-test', f.root)
  await writer.request('request-fixture', { turn: 1, step: 1 }, { ...selected, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'api_key=synthetic-fixture-value' }] })] })
  await writer.response('request-fixture', selected, createMessage({ role: 'assistant', source: { kind: 'model', ...selected, replayState: { signature: 'fixture-signature' } }, content }))
  const reader = new ModelJournal('journal-test', f.root)
  expect((await reader.replay(selected, content))?.source).toMatchObject({ replayState: { signature: 'fixture-signature' } })
  expect(await reader.replay({ ...selected, model: 'two' }, content)).toBeUndefined()
  expect(await reader.replay(selected, [{ type: 'text', text: 'different' }])).toBeUndefined()
  const dirs = await readdir(f.root)
  const recorded = await readFile(join(f.root, dirs[0]!, 'request-fixture.request.json'), 'utf8')
  expect(recorded).toContain('[REDACTED]')
  expect(recorded).not.toContain('synthetic-fixture-value')
})
