import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session-reference/types'
import { createUserMessage, ReasoningEffortId, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'
import { ClaudeCodeAdapter, resolveDirectUserPrompt } from '../src/adapter.ts'
import { CLAUDE_CODE_PROVIDER_IDS } from '../src/constants.ts'
import { claudeModelRow, claudeModelValue, latestClaudeModels, recordClaudeModels, resetClaudeModels } from '../src/model-catalog.ts'
import type { ClaudeSupervisor, ClaudeTurnStreamEvent } from '../src/supervisor.ts'

const user = (text: string, kind: 'user' | 'plugin' = 'user') => ({
  id: crypto.randomUUID(),
  role: 'user',
  content: [{ type: 'text', text }],
  source: kind === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'test', form: 'notice', summary: 'test' },
}) as unknown as Message

const agent = { id: 'session-1' } as unknown as Agent
const claudePreset = () => 'claude'

const resourceContext = (text: string) => createUserMessage({
  source: { kind: 'plugin', plugin: 'aiko-dsh-workbench-kit', form: 'snapshot', sections: [{ name: 'Resource', text }] },
  content: [{ type: 'text', text }],
})

const sessionContext = (text: string) => createUserMessage({
  source: { kind: 'session-reference', form: 'recall', version: 1, references: [] },
  content: [{ type: 'text', text }],
})

const imageLimits = {
  maxImageBytes: 10,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 16,
  maxImagePixels: 1_000_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
}

const imageRef = (overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef => ({
  attachmentId: 'sha256:test-image' as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
  ...overrides,
})

function attachmentStore(
  readImage: Pick<AttachmentStore, 'readImage'>['readImage'] = async ref => ({
    ref,
    data: Uint8Array.from([1, 2, 3]),
  }),
): Pick<AttachmentStore, 'imageLimits' | 'readImage'> {
  return { imageLimits, readImage }
}

const imageMessage = (content: Message['content']) => ({
  id: crypto.randomUUID(),
  role: 'user',
  content,
  source: { kind: 'user' },
}) as Message

function options(messages: Message[] = [user('hello')]): GenerateOptions {
  return {
    provider: 'claude',
    model: 'default',
    messages,
    sessionId: 'session-1' as never,
  }
}

function supervisorEvents(events: ClaudeTurnStreamEvent[], error?: unknown, contextWindow?: number) {
  return {
    contextWindow: () => contextWindow,
    runTurn: async function* () {
      for (const event of events) yield event
      if (error !== undefined) throw error
    },
  } as unknown as ClaudeSupervisor
}

function capturingSupervisor(events: ClaudeTurnStreamEvent[] = [{ type: 'complete', text: 'ok' }]) {
  const calls: Array<{ prompt: unknown; model?: string; thinkingMode?: string; renderMode?: string }> = []
  const supervisor = {
    contextWindow: () => undefined,
    runTurn: (request: { prompt: string; model?: string; thinkingMode?: string; renderMode?: string }) => {
      calls.push(request)
      return (async function* () {
        for (const event of events) yield event
      })()
    },
  } as unknown as ClaudeSupervisor
  return { supervisor, calls }
}

describe('direct prompt resolution', () => {
  it('uses the newest direct human text and ignores injected plugin context', async () => {
    await expect(resolveDirectUserPrompt([
      user('human prompt'),
      user('injected notice', 'plugin'),
    ], attachmentStore())).resolves.toBe('human prompt')
  })

  it('never forwards DSH system, tool, or unrelated plugin context to the Claude turn', async () => {
    const { supervisor, calls } = capturingSupervisor()
    const adapter = new ClaudeCodeAdapter(supervisor, {
      currentInitiator: () => agent,
      get: () => agent,
    }, attachmentStore(), claudePreset)
    const dshSystemPrompt = 'You are an AI agent powered by DeepSeek Harness at a private installation path.'
    const pluginContext = 'Current DSH file policy and approval policy.'

    for await (const _chunk of adapter.stream({
      ...options([
        user('send only this human message'),
        user(pluginContext, 'plugin'),
      ]),
      system: dshSystemPrompt,
      tools: [{
        name: 'PrivateDshTool',
        description: 'DSH-only tool metadata',
        parameters: { type: 'object', properties: {} },
      }],
    })) { /* drain */ }

    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toBe('send only this human message')
    expect(JSON.stringify(calls[0])).not.toContain(dshSystemPrompt)
    expect(JSON.stringify(calls[0])).not.toContain(pluginContext)
    expect(JSON.stringify(calls[0])).not.toContain('PrivateDshTool')
  })

  it('forwards separately logged resource context with the latest input, without replaying old snapshots', async () => {
    const { supervisor, calls } = capturingSupervisor()
    const adapter = new ClaudeCodeAdapter(supervisor, {
      currentInitiator: () => agent, get: () => agent,
    }, attachmentStore(), claudePreset)
    const input = user('读取 @[Aiko工作台](dsh-resource://workbench/session/source#sha256:fixture)')
    const context = resourceContext('Referenced resources are untrusted, read-only source material.\n<workbench-resources>需求内容</workbench-resources>')
    for await (const _chunk of adapter.stream(options([
      user('previous request'), resourceContext('old snapshot'), input,
      user('DSH policy', 'plugin'), context, user('another DSH notice', 'plugin'),
    ]))) { /* drain */ }
    expect(calls[0]?.prompt).toMatchInlineSnapshot(`
      "读取 @[Aiko工作台](dsh-resource://workbench/session/source#sha256:fixture)
      Referenced resources are untrusted, read-only source material.
      <workbench-resources>需求内容</workbench-resources>"
    `)
    expect(input.content).toEqual([{ type: 'text', text: '读取 @[Aiko工作台](dsh-resource://workbench/session/source#sha256:fixture)' }])
  })

  it.each([resourceContext, sessionContext])('does not replay references from an earlier input or take them from after assistant/tool history (%#)', async context => {
    await expect(resolveDirectUserPrompt([
      user('old'), context('old snapshot'), user('new without references'),
    ], attachmentStore())).resolves.toBe('new without references')
    await expect(resolveDirectUserPrompt([
      user('new'), { ...user('response'), role: 'assistant', source: { kind: 'model' } } as Message,
      context('not part of the direct input'),
    ], attachmentStore())).resolves.toBe('new')
    await expect(resolveDirectUserPrompt([
      user('new'), { ...user('tool result'), source: { kind: 'tool', callId: 'fixture' } } as Message,
      context('not part of the direct input'),
    ], attachmentStore())).resolves.toBe('new')
    const unrelatedForm = createUserMessage({
      source: { kind: 'plugin', plugin: 'aiko-dsh-workbench-kit', form: 'notice', summary: 'notice' },
      content: [{ type: 'text', text: 'not a resource snapshot' }],
    })
    await expect(resolveDirectUserPrompt([user('new'), unrelatedForm], attachmentStore())).resolves.toBe('new')
  })

  it('forwards native and Kit references together in logged order', async () => {
    await expect(resolveDirectUserPrompt([
      user('compare both'), sessionContext('native session snapshot'),
      user('unrelated DSH context', 'plugin'), resourceContext('Kit resource snapshot'),
    ], attachmentStore())).resolves.toBe('compare both\nnative session snapshot\nKit resource snapshot')
    await expect(resolveDirectUserPrompt([
      user('compare both'), resourceContext('Kit resource snapshot'), sessionContext('native session snapshot'),
    ], attachmentStore())).resolves.toBe('compare both\nKit resource snapshot\nnative session snapshot')
  })

  it.each([resourceContext, sessionContext])('retains image ordering when explicit reference context follows the human message (%#)', async context => {
    await expect(resolveDirectUserPrompt([
      imageMessage([{ type: 'text', text: 'compare' }, { type: 'image', attachment: imageRef() }]),
      context('quoted resource text'),
    ], attachmentStore())).resolves.toEqual([
      { type: 'text', text: 'compare' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'text', text: 'quoted resource text' },
    ])
  })

  it('resolves an image-only prompt through the verified attachment store', async () => {
    await expect(resolveDirectUserPrompt([
      imageMessage([{ type: 'image', attachment: imageRef() }]),
    ], attachmentStore())).resolves.toEqual([{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AQID' },
    }])
  })

  it('preserves interleaved text and multiple-image ordering', async () => {
    const second = imageRef({ attachmentId: 'sha256:second' as ImageAttachmentRef['attachmentId'], mediaType: 'image/jpeg' })
    const readImage = vi.fn(async (ref: ImageAttachmentRef) => ({ ref, data: Uint8Array.from([1, 2, 3]) }))
    await expect(resolveDirectUserPrompt([
      imageMessage([
        { type: 'text', text: 'before' },
        { type: 'image', attachment: imageRef() },
        { type: 'text', text: 'between' },
        { type: 'image', attachment: second },
      ]),
    ], attachmentStore(readImage))).resolves.toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'text', text: 'between' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AQID' } },
    ])
    expect(readImage.mock.calls.map(([ref]) => ref.attachmentId)).toEqual([
      'sha256:test-image',
      'sha256:second',
    ])
  })

  it('rejects declared limits before reading any bytes', async () => {
    const readImage = vi.fn(attachmentStore().readImage)
    await expect(resolveDirectUserPrompt([
      imageMessage([
        { type: 'image', attachment: imageRef() },
        { type: 'image', attachment: imageRef() },
        { type: 'image', attachment: imageRef() },
      ]),
    ], attachmentStore(readImage))).rejects.toThrow(/image-count limit/)
    expect(readImage).not.toHaveBeenCalled()

    await expect(resolveDirectUserPrompt([
      imageMessage([{ type: 'image', attachment: imageRef({ bytes: 11 }) }]),
    ], attachmentStore(readImage))).rejects.toThrow(/byte limit/)
    expect(readImage).not.toHaveBeenCalled()
  })

  it('rejects unsupported media and aggregate bytes without exposing attachment identity', async () => {
    const maliciousId = 'secret/local/path/token' as ImageAttachmentRef['attachmentId']
    const unsupported = imageRef({ attachmentId: maliciousId, mediaType: 'image/svg+xml' as ImageAttachmentRef['mediaType'] })
    const mediaError = await resolveDirectUserPrompt([
      imageMessage([{ type: 'image', attachment: unsupported }]),
    ], attachmentStore()).catch((error: unknown) => error as Error)
    expect(mediaError.message).toMatch(/unsupported media type/)
    expect(mediaError.message).not.toContain(maliciousId)

    await expect(resolveDirectUserPrompt([
      imageMessage([
        { type: 'image', attachment: imageRef({ bytes: 9 }) },
        { type: 'image', attachment: imageRef({ bytes: 9 }) },
      ]),
    ], attachmentStore())).rejects.toThrow(/aggregate image-byte limit/)
  })

  it('bounds unreadable attachment errors and preserves cancellation', async () => {
    const unreadable = attachmentStore(async () => {
      throw new Error('sensitive /private/path bearer-token-value')
    })
    const readError = await resolveDirectUserPrompt([
      imageMessage([{ type: 'image', attachment: imageRef() }]),
    ], unreadable).catch((error: unknown) => error as Error)
    expect(readError.message).toBe('dsh-claude: image 1 could not be read or verified')

    const controller = new AbortController()
    const aborted = attachmentStore(async (_ref, signal) => {
      controller.abort(new DOMException('cancelled', 'AbortError'))
      signal?.throwIfAborted()
      throw new Error('unreachable')
    })
    const abortError = await resolveDirectUserPrompt([
      imageMessage([{ type: 'image', attachment: imageRef() }]),
    ], aborted, controller.signal).catch((error: unknown) => error as Error)
    expect(abortError.name).toBe('AbortError')
  })
})

describe('DSH stream mapping', () => {
  it('exposes the Desktop prepareCall contract and dispatches through the prepared stream', async () => {
    const { supervisor, calls } = capturingSupervisor()
    const adapter = new ClaudeCodeAdapter(supervisor, {
      currentInitiator: () => agent,
      get: () => agent,
    }, attachmentStore(), claudePreset)

    const prepared = await adapter.prepareCall('claude', 'default')
    expect(prepared.model).toMatchObject({ provider: 'claude', id: 'default' })
    const chunks = []
    for await (const chunk of prepared.stream(options())) chunks.push(chunk)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ prompt: 'hello', model: 'default' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reads the renderer setting once per turn and pins it to that turn', async () => {
    // Read per turn, not cached: a copy held in memory goes stale the moment
    // the settings file is edited outside the Settings dialog. Read once, not
    // per record: both halves of a turn -- the records the supervisor stamps
    // and the blocks streamed here -- have to agree about who is drawing it.
    const { supervisor, calls } = capturingSupervisor()
    const modes = ['plugin', 'native'] as const
    let reads = 0
    const adapter = new ClaudeCodeAdapter(supervisor, {
      currentInitiator: () => agent,
      get: () => agent,
    }, attachmentStore(), claudePreset, () => [], async () => modes[reads++] ?? 'plugin')

    for await (const _chunk of adapter.stream(options())) { /* drain */ }
    for await (const _chunk of adapter.stream(options())) { /* drain */ }

    expect(reads).toBe(2)
    expect(calls.map(call => call.renderMode)).toEqual(['plugin', 'native'])
  })

  it('emits only usage and an empty assistant completion anchor while sidecar owns visible text', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([
      { type: 'text-delta', text: 'hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1 } },
      { type: 'complete', text: 'hello' },
    ]), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset, () => [], async () => 'plugin')
    const chunks = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('keeps every task-report segment in the sidecar before one empty assistant finish', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([
      { type: 'text-delta', text: 'Tasks are still running.' },
      { type: 'segment-complete', text: 'Tasks are still running.' },
      { type: 'text-delta', text: 'Deploy locked on; waiting for the build.' },
      { type: 'segment-complete', text: 'Deploy locked on; waiting for the build.' },
      { type: 'text-delta', text: 'All tasks completed.' },
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } },
      { type: 'complete', text: 'All tasks completed.' },
    ]), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset, () => [], async () => 'plugin')
    const chunks = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('emits no text block for a turn without visible text', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } },
      { type: 'complete', text: '' },
    ]), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    const chunks = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(chunks.some(chunk => chunk.type === 'block-start')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('emits no Claude tool calls into the DSH stream', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([
      { type: 'text-delta', text: 'done' },
      { type: 'complete', text: 'done' },
    ]), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    const chunks = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(false)
  })

  it('emits an aborted finish instead of throwing an AbortError', async () => {
    const abort = new Error('Claude Code turn aborted')
    abort.name = 'AbortError'
    const adapter = new ClaudeCodeAdapter(supervisorEvents([{ type: 'text-delta', text: 'partial' }], abort), {
      currentInitiator: () => agent,
      get: () => agent,
    }, attachmentStore(), claudePreset, () => [], async () => 'plugin')
    const chunks = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'aborted', failure: { code: 'aborted', message: 'Claude Code turn aborted' } } },
    ])
  })

  it('rejects a native or recomposed session even if the global provider is selected', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), () => 'standard')
    await expect(async () => {
      for await (const _chunk of adapter.stream(options())) { /* no chunks expected */ }
    }).rejects.toThrow(/available only to the claude preset/)
  })

  it('maps cancellation during image resolution without starting Claude', async () => {
    const controller = new AbortController()
    const { supervisor, calls } = capturingSupervisor()
    const store = attachmentStore(async (_ref, signal) => {
      controller.abort(new DOMException('cancelled', 'AbortError'))
      signal?.throwIfAborted()
      throw new Error('unreachable')
    })
    const adapter = new ClaudeCodeAdapter(supervisor, { currentInitiator: () => agent, get: () => agent }, store, claudePreset)
    const chunks = []
    for await (const chunk of adapter.stream({
      ...options([imageMessage([{ type: 'image', attachment: imageRef() }])]),
      signal: controller.signal,
    })) chunks.push(chunk)
    expect(chunks).toEqual([{
      type: 'finish',
      reason: { kind: 'aborted', failure: { code: 'aborted', message: 'cancelled' } },
    }])
    expect(calls).toHaveLength(0)
  })

  it('disables outer DSH retries', () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    expect(adapter.providerRetryPolicy('claude')).toMatchObject({ mode: 'normal', maxRetries: 0 })
  })
})

describe('Claude Code model catalog', () => {
  afterEach(() => { resetClaudeModels() })

  it('registers only the current Claude provider in the model selector', () => {
    expect(CLAUDE_CODE_PROVIDER_IDS).toEqual(['claude'])
  })

  it('advertises whichever lineup the running CLI reported, in its order', async () => {
    // The point of the catalog: a model Claude Code ships after this release
    // reaches the selector without an edit here.
    recordClaudeModels([
      { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5 with 1M context' },
      { value: 'claude-nextthing-9', displayName: 'Nextthing', description: 'Ships after this plugin release' },
    ])
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    const models = await adapter.listModels('claude')
    expect(models.every(model => model.inputModalities?.join(',') === 'text,image')).toBe(true)
    expect(models.map(model => ({ id: model.id, name: model.name }))).toEqual([
      { id: 'default', name: 'Default (recommended)' },
      { id: 'nextthing', name: 'Nextthing' },
    ])
  })

  it('seeds the selector with the stable aliases before any session reports', async () => {
    // A fresh app launch must not show a one-row menu until someone starts a session.
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    expect((await adapter.listModels('claude')).map(model => model.id)).toEqual(['default', 'opus[1m]', 'fable', 'sonnet', 'haiku'])
  })

  it('publishes the 1M capacity spelled in a route id through the native DSH model contract', async () => {
    recordClaudeModels([{ value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: '' }])
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    await expect(adapter.resolveModel('claude', 'opus[1m]')).resolves.toMatchObject({
      context: { contextWindow: 1_000_000 },
    })
  })

  it('publishes an SDK-observed capacity for dynamic Claude aliases', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([], undefined, 272_000), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    await expect(adapter.resolveModel('claude', 'default')).resolves.toMatchObject({
      context: { contextWindow: 272_000 },
    })
  })

  it('omits unverified capacity until Claude reports it', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    const model = await adapter.resolveModel('claude', 'sonnet')
    expect(model.context).toBeUndefined()
  })

  it('forwards the selected native alias unchanged to the supervisor', async () => {
    const { supervisor, calls } = capturingSupervisor()
    const adapter = new ClaudeCodeAdapter(supervisor, { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    for await (const _chunk of adapter.stream({ ...options(), model: 'opus[1m]' })) { /* drain */ }
    expect(calls[0]).toMatchObject({ model: 'opus[1m]' })
  })

  it('never advertises a CLI model id, so a version bump cannot dangle a persisted selection', async () => {
    // DSH persists the row id verbatim and matches it back by string equality.
    // An id carrying the version (`claude-fable-5-1[1m]`) stops resolving the
    // day Anthropic ships `-5-2`, and the composer prints the raw id instead.
    recordClaudeModels([
      { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1[1m]', displayName: 'Fable', description: '' },
      { value: 'claude-3-5-sonnet-20241022', displayName: 'Sonnet', description: '' },
    ])
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    expect((await adapter.listModels('claude')).map(model => model.id)).toEqual(['fable[1m]', 'sonnet'])
    expect(claudeModelValue('fable[1m]')).toBe('claude-fable-5-1[1m]')
  })

  it('keeps a family apart from its 1M route, and keeps a repeated family addressable', () => {
    recordClaudeModels([
      { value: 'claude-opus-5', displayName: 'Opus', description: '' },
      { value: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: '' },
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: '' },
    ])
    expect(latestClaudeModels().map(row => row.id)).toEqual(['opus', 'opus[1m]', 'claude-opus-4-8'])
  })

  it('still resolves a concrete id persisted before the selector aliased anything', () => {
    recordClaudeModels([{ value: 'claude-fable-5-1[1m]', displayName: 'Fable', description: '' }])
    // The old session holds the CLI id; dispatch has to keep working on it.
    expect(claudeModelValue('claude-fable-5-1[1m]')).toBe('claude-fable-5-1[1m]')
    expect(claudeModelRow('claude-fable-5-2[1m]')?.id).toBe('fable[1m]')
  })

  it('learns the lineup from a throwaway CLI probe, without waiting for a session', async () => {
    // DSH loads the catalog once per Host generation, at connect. Left on the
    // seed until a session starts, the selector hands out seed ids that the
    // next launch cannot resolve.
    let probes = 0
    const probe = async (): Promise<readonly ModelInfo[]> => {
      probes += 1
      return [{ value: 'claude-nextthing-9', displayName: 'Nextthing', description: '' }]
    }
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset, undefined, undefined, undefined, probe)
    const [first, second] = await Promise.all([adapter.listModels('claude'), adapter.listModels('claude')])
    expect(first.map(model => model.id)).toEqual(['nextthing'])
    expect(second.map(model => model.id)).toEqual(['nextthing'])
    expect(probes).toBe(1)
  })

  it('falls back to the seed when the probe cannot answer', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset, undefined, undefined, undefined, async () => { throw new Error('claude: not logged in') })
    expect((await adapter.listModels('claude')).map(model => model.id)).toEqual(['default', 'opus[1m]', 'fable', 'sonnet', 'haiku'])
  })
})

describe('reasoning effort', () => {
  it('advertises the seven Claude thinking modes for selector surfaces', async () => {
    const adapter = new ClaudeCodeAdapter(supervisorEvents([]), { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    const info = await adapter.resolveModel('claude', 'sonnet')
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(info.reasoning?.defaultEffort).toBeUndefined()
  })

  it('forwards the selected thinking mode to the supervisor', async () => {
    const { supervisor, calls } = capturingSupervisor()
    const adapter = new ClaudeCodeAdapter(supervisor, { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    for await (const _chunk of adapter.stream({ ...options(), reasoningEffort: ReasoningEffortId('max') })) { /* drain */ }
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ prompt: 'hello', thinkingMode: 'max' })
  })

  it('omits the thinking mode when no effort is selected', async () => {
    const { supervisor, calls } = capturingSupervisor()
    const adapter = new ClaudeCodeAdapter(supervisor, { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    for await (const _chunk of adapter.stream(options())) { /* drain */ }
    expect(calls[0]).not.toHaveProperty('thinkingMode')
  })

  it('rejects an unknown reasoning effort before touching the Claude session', async () => {
    const { supervisor, calls } = capturingSupervisor()
    const adapter = new ClaudeCodeAdapter(supervisor, { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    await expect(async () => {
      for await (const _chunk of adapter.stream({ ...options(), reasoningEffort: ReasoningEffortId('turbo') })) { /* no chunks expected */ }
    }).rejects.toThrow(/unsupported reasoning effort/)
    expect(calls).toHaveLength(0)
  })
})

describe('DSH stream mapping under the native renderer', () => {
  const nativeAdapter = (events: ClaudeTurnStreamEvent[], error?: unknown) => new ClaudeCodeAdapter(
    supervisorEvents(events, error),
    { currentInitiator: () => agent, get: () => agent },
    attachmentStore(),
    claudePreset,
    () => [],
    () => 'native',
  )

  it('streams each delta before settling the result as one text block', async () => {
    const adapter = nativeAdapter([
      { type: 'text-delta', text: 'hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1 } },
      { type: 'complete', text: 'hello' },
    ])
    const chunks = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('publishes text before asking the engine for its next event', async () => {
    let continued = false
    const supervisor = {
      contextWindow: () => undefined,
      async *runTurn() {
        yield { type: 'text-delta', text: 'first' }
        continued = true
        yield { type: 'complete', text: 'first' }
      },
    } as unknown as ClaudeSupervisor
    const adapter = new ClaudeCodeAdapter(supervisor, { currentInitiator: () => agent, get: () => agent }, attachmentStore(), claudePreset)
    const stream = adapter.stream(options())[Symbol.asyncIterator]()
    try {
      expect((await stream.next()).value).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
      expect((await stream.next()).value).toEqual({ type: 'text-delta', index: 0, text: 'first' })
      expect(continued).toBe(false)
      while (!(await stream.next()).done) { /* drain */ }
    } finally { await stream.return?.() }
  })

  it('closes prose at tool boundaries without an intermediate turn finish', async () => {
    const chunks = []
    for await (const chunk of nativeAdapter([
      { type: 'text-delta', text: 'Before tool' }, { type: 'text-boundary' },
      { type: 'text-delta', text: 'After tool' }, { type: 'complete', text: 'After tool' },
    ]).stream(options())) chunks.push(chunk)
    expect(chunks.filter(chunk => chunk.type === 'block-end')).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Before tool' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'After tool' } },
    ])
    expect(chunks.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
  })

  it('gives each task-report segment its own block before one finish', async () => {
    const adapter = nativeAdapter([
      { type: 'text-delta', text: 'Tasks are still running.' },
      { type: 'segment-complete', text: 'Tasks are still running.' },
      { type: 'text-delta', text: 'All tasks completed.' },
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } },
      { type: 'complete', text: 'All tasks completed.' },
    ])
    const chunks = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(chunks.filter(chunk => chunk.type === 'block-end')).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Tasks are still running.' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'All tasks completed.' } },
    ])
  })

  it('draws settled thinking as a reasoning block ahead of the prose it precedes', async () => {
    const adapter = nativeAdapter([
      { type: 'thinking', text: 'Weighing the options.' },
      { type: 'text-delta', text: 'Here is the plan.' },
      { type: 'complete', text: 'Here is the plan.' },
    ])
    const chunks = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'Weighing the options.' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Weighing the options.' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Here is the plan.' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Here is the plan.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('settles the delivered prefix before an aborted finish', async () => {
    const abort = new Error('Claude Code turn aborted')
    abort.name = 'AbortError'
    const adapter = nativeAdapter([{ type: 'text-delta', text: 'partial' }], abort)
    const chunks = []
    for await (const chunk of adapter.stream(options())) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } },
      { type: 'finish', reason: { kind: 'aborted', failure: { code: 'aborted', message: 'Claude Code turn aborted' } } },
    ])
  })
})
