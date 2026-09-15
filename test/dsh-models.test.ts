import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { deepSeekAnthropicURL, installDshModelRouting, resolveDshModelConnection } from '../src/dsh-models.ts'

function host(settings: unknown = {}, key = 'fixture-dsh-key') {
  const resolve = vi.fn(async () => ({ value: key }))
  const services: Record<string, unknown> = {
    settings: { get: () => settings },
    credentials: { resolve },
    launchEnvironment: createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
  }
  const ctx = { get: (name: string) => services[name] } as unknown as Context
  return { ctx, resolve }
}

describe('DSH model connection', () => {
  it('routes role-based titles to the DSH Haiku mapping without a native Claude call', async () => {
    type Listener = (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
    let listener!: Listener
    const stream = vi.fn(async function* (_options: GenerateOptions) { yield { type: 'text-delta', index: 0, text: 'DSH title' } as StreamChunk })
    const next = vi.fn(async function* () { yield { type: 'text-delta', index: 0, text: 'Native title' } as StreamChunk })
    const ctx = { on: (_name: string, handler: Listener) => { listener = handler }, llm: { stream } } as unknown as Context
    let native = false
    installDshModelRouting(ctx, { stream }, async () => ({ source: native ? 'native' : 'dsh', roles: { haiku: { provider: 'deepseek-official', model: 'haiku-mapped-id' } } }))
    const options: GenerateOptions = { provider: 'claude', model: 'opus', purpose: 'session-title', messages: [] }
    const first = []
    for await (const chunk of listener(options, next)) first.push(chunk)
    expect(stream).toHaveBeenCalledWith({ ...options, provider: 'deepseek-official', model: 'haiku-mapped-id' })
    expect(next).not.toHaveBeenCalled()
    expect(first).toEqual([{ type: 'text-delta', index: 0, text: 'DSH title' }])
    native = true
    for await (const _ of listener(options, next)) { /* consume native title */ }
    expect(next).toHaveBeenCalledOnce()
  })

  it('intercepts an Agent request outside the plugin listener scope on a real Cordis runtime', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    ctx.provide('agents', { currentInitiator: () => ({ ctx }) })
    ctx.provide('agentPresets', { composedPreset: () => 'claude' })
    await ctx.plugin(LlmRuntime)
    const bridge = { stream: vi.fn(async function* () { yield { type: 'text-delta', index: 0, text: 'Code engine' } as StreamChunk }) }
    installDshModelRouting(ctx.extend({ filter: () => false }), bridge)
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] })) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'text-delta', index: 0, text: 'Code engine' }])
    expect(bridge.stream).toHaveBeenCalledOnce()
  })

  it('routes only Code turns through Claude while preserving logged DSH model selection', () => {
    type Listener = (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
    let listener!: Listener
    let preset = 'claude'
    const ctx = {
      on: (_name: string, handler: Listener) => { listener = handler },
      agents: { get: () => ({ ctx: {} }), currentInitiator: () => ({ ctx: {} }) },
      agentPresets: { composedPreset: () => preset },
    } as unknown as Context
    const stream = vi.fn(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk })
    const next = vi.fn(() => stream())
    installDshModelRouting(ctx, { stream })
    const options: GenerateOptions = { provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] }
    listener(options, next)
    expect(stream).toHaveBeenCalledWith(options)
    expect(next).not.toHaveBeenCalled()
    listener({ ...options, purpose: 'session-title' }, next)
    expect(next).toHaveBeenCalledTimes(1)
    preset = 'standard'
    listener(options, next)
    expect(next).toHaveBeenCalledTimes(2)
    preset = 'claude'
    listener({ ...options, provider: 'claude' }, next)
    expect(next).toHaveBeenCalledTimes(3)
  })

  it('resolves DSH credentials and binds every Claude model role to the selected model', async () => {
    const h = host({ apiKeyEnv: 'TEAM_DEEPSEEK_KEY' })
    const connection = await resolveDshModelConnection(h.ctx, 'deepseek-official', 'deepseek-v4-pro')
    expect(h.resolve).toHaveBeenCalledWith('TEAM_DEEPSEEK_KEY')
    expect(connection?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_API_KEY: 'fixture-dsh-key',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-pro',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-pro',
    })
    expect(connection?.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(connection?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(connection?.revision).not.toContain('fixture-dsh-key')
    expect(connection?.revision).toBe((await resolveDshModelConnection(h.ctx, 'deepseek-official', 'deepseek-v4-pro'))?.revision)
    expect((await resolveDshModelConnection(host({}, 'rotated-fixture-key').ctx, 'deepseek-official', 'deepseek-v4-pro'))?.revision).not.toBe(connection?.revision)
  })

  it('keeps native Claude credentials untouched for explicit Claude selections', async () => {
    const h = host()
    expect(await resolveDshModelConnection(h.ctx, 'claude', 'sonnet')).toBeUndefined()
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it.each(['deepseek-v4-flash', 'deepseek-flash'])('keeps session selection %s usable after the catalog id changes', async model => {
    const h = host({ models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4-Flash-Vision-Exp' }] })
    const connection = await resolveDshModelConnection(h.ctx, 'deepseek-official', model)
    expect(connection?.model).toBe(model)
    expect(connection?.env.ANTHROPIC_MODEL).toBe(model)
    expect(connection?.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(model)
    expect(h.resolve).toHaveBeenCalledOnce()
  })

  it.each(['https://api.deepseek.com', 'https://gateway.example/team/v1'])('passes custom catalog ids unchanged to %s', async baseURL => {
    const h = host({ baseURL, models: [{ id: 'team-code-model', name: 'Team Code' }] })
    const connection = await resolveDshModelConnection(h.ctx, 'deepseek-official', 'team-code-model')
    expect(connection?.env.ANTHROPIC_BASE_URL).toBe(deepSeekAnthropicURL(baseURL))
    expect(connection?.env.ANTHROPIC_MODEL).toBe('team-code-model')
  })

  it('keeps the connection stable across display-name changes and catalog removal', async () => {
    const settings = { models: [{ id: 'deepseek-flash', name: 'Original label' }] }
    const h = host(settings)
    const original = await resolveDshModelConnection(h.ctx, 'deepseek-official', 'deepseek-flash')
    settings.models[0]!.name = 'Renamed label'
    expect(await resolveDshModelConnection(h.ctx, 'deepseek-official', 'deepseek-flash')).toEqual(original)
    settings.models = []
    expect(await resolveDshModelConnection(h.ctx, 'deepseek-official', 'deepseek-flash')).toEqual(original)
  })

  it.each([
    ['https://api.deepseek.com/v1/', 'https://api.deepseek.com/anthropic'],
    ['https://gateway.example/team/v1', 'https://gateway.example/team/anthropic'],
    ['https://gateway.example/team/anthropic', 'https://gateway.example/team/anthropic'],
  ])('preserves the configured endpoint %s', (url, expected) => {
    expect(deepSeekAnthropicURL(url)).toBe(expected)
  })

  it.each(['https://user:secret@example.com', 'https://example.com?key=secret', 'file:///tmp/socket'])('refuses credential-bearing or unsupported endpoints', url => {
    expect(() => deepSeekAnthropicURL(url)).toThrow('HTTP endpoint')
  })

  it('fails before resolving credentials for unsupported providers', async () => {
    const h = host()
    await expect(resolveDshModelConnection(h.ctx, 'other', 'test')).rejects.toThrow('requires the DSH model transport')
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it('fails without a usable DSH credential instead of falling back to Claude auth', async () => {
    await expect(resolveDshModelConnection(host({}, '').ctx, 'deepseek-official', 'deepseek-v4-flash')).rejects.toThrow()
  })
})
