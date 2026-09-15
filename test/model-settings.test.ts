import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { readGlobalSettings, readModelSettings, updateGlobalSettings } from '../src/global-settings.ts'
import { listDshModelOptions, mappedRoleInfo, mappedRoleModels, resolveDshModelConnection } from '../src/dsh-models.ts'
import { modelSettingsFrom, type ClaudeModelSettings } from '../src/model-settings.ts'

const reference = (model: string) => ({ provider: 'deepseek-official', model })
function host() {
  const selected = reference('deepseek-flash')
  const credentials = { resolve: vi.fn(async () => ({ value: 'fixture-dsh-key' })) }
  const llm = {
    listProviders: () => [{ id: 'deepseek-official' }, { id: 'claude' }],
    listModels: vi.fn(async () => [{ provider: 'deepseek-official', id: 'deepseek-flash', name: 'Renamed display label' }]),
    resolveModelInfo: vi.fn(async (provider: string, model: string) => ({ provider, id: model, name: 'DSH model', context: { contextWindow: 1_000_000 }, inputModalities: ['text'] })),
  }
  const services: Record<string, unknown> = {
    credentials, llm,
    settings: { get: () => ({}) },
    agentDefaultModel: { currentSelection: () => selected },
    launchEnvironment: createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
  }
  return { ctx: { get: (key: string) => services[key], llm } as unknown as Context, selected, credentials, llm }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiko-model-settings-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return { settingsFile: join(root, 'claude.json'), pluginSettingsFile: join(root, 'plugin.json'), outputStylesDir: join(root, 'styles') }
}

describe('Claude model sources and role mappings', () => {
  it('uses the Cowork registry labels and persists references only in plugin settings', async () => {
    const h = host()
    const paths = await fixture()
    const nativeSettings = { env: { ANTHROPIC_AUTH_TOKEN: 'fixture-native-token' }, model: 'sonnet' }
    await writeFile(paths.settingsFile, JSON.stringify(nativeSettings))
    const deps = { paths, modelOptions: () => listDshModelOptions(h.ctx) }
    const view = await readGlobalSettings(deps)
    expect(h.llm.listModels).toHaveBeenCalledWith('deepseek-official')
    expect(view.settings.find(setting => setting.key === 'modelHaiku')).toMatchObject({
      value: 'default', options: [{ value: 'default' }, { label: 'Renamed display label · deepseek-flash' }],
    })
    const value = JSON.stringify(reference('deepseek-flash'))
    await updateGlobalSettings({ modelSource: 'dsh', modelHaiku: value, modelSonnet: value, modelOpus: value }, deps)
    expect(await readModelSettings(deps)).toEqual({ source: 'dsh', roles: { haiku: reference('deepseek-flash'), sonnet: reference('deepseek-flash'), opus: reference('deepseek-flash') } })
    expect(JSON.parse(await readFile(paths.settingsFile, 'utf8'))).toEqual(nativeSettings)
    expect(await readFile(paths.pluginSettingsFile, 'utf8')).not.toContain('token')
    await updateGlobalSettings({ modelSource: 'native' }, deps)
    expect((await readModelSettings(deps)).roles.haiku).toEqual(reference('deepseek-flash'))
    await updateGlobalSettings({ modelSource: 'dsh', modelHaiku: 'default' }, deps)
    expect((await readModelSettings(deps)).roles.haiku).toBeUndefined()
  })

  it('rejects unavailable new mappings and malformed settings without writing partial changes', async () => {
    const paths = await fixture()
    const h = host()
    const deps = { paths, modelOptions: () => listDshModelOptions(h.ctx) }
    await expect(updateGlobalSettings({ modelSource: 'native', modelHaiku: JSON.stringify(reference('missing')) }, deps)).rejects.toThrow('current DSH model list')
    await expect(readFile(paths.pluginSettingsFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => modelSettingsFrom({ modelSource: 'other' })).toThrow('invalid model source')
    expect(() => modelSettingsFrom({ modelHaiku: JSON.stringify({ provider: 'claude', model: 'haiku' }) })).toThrow('supported provider connection')
    await writeFile(paths.pluginSettingsFile, '{broken')
    await expect(readModelSettings(deps)).rejects.toThrow()
  })

  it('keeps saved IDs after catalog edits and resolves each role independently', async () => {
    const h = host()
    const settings: ClaudeModelSettings = { source: 'dsh', roles: { haiku: reference('old-custom-id'), sonnet: reference('deepseek-flash'), opus: reference('deepseek-v4-pro') } }
    const connection = await resolveDshModelConnection(h.ctx, 'claude', 'opus', settings)
    expect(connection).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-pro', env: {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'old-custom-id', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash', ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
    } })
    expect(connection?.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()
    expect((await mappedRoleModels(h.ctx, settings))?.map(model => model.id)).toEqual(['haiku', 'sonnet', 'opus'])
    expect(await mappedRoleInfo(h.ctx, settings, 'opus[1m]')).toMatchObject({ provider: 'claude', id: 'opus[1m]', inputModalities: ['text'], context: { contextWindow: 1_000_000 } })
    const changed = await resolveDshModelConnection(h.ctx, 'claude', 'opus', { ...settings, roles: { ...settings.roles, haiku: reference('new-id') } })
    expect(changed?.revision).not.toBe(connection?.revision)
  })

  it('reads the live DSH default for unset roles and preserves a direct main selection', async () => {
    const h = host()
    const settings: ClaudeModelSettings = { source: 'dsh', roles: {} }
    expect((await resolveDshModelConnection(h.ctx, 'claude', 'default', settings))?.model).toBe('deepseek-flash')
    h.selected.model = 'new-default'
    const direct = await resolveDshModelConnection(h.ctx, 'deepseek-official', 'explicit-main', settings)
    expect(direct?.model).toBe('explicit-main')
    expect(direct?.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('new-default')
  })

  it('does not resolve DSH credentials or mapped model metadata in native mode', async () => {
    const h = host()
    const settings: ClaudeModelSettings = { source: 'native', roles: { haiku: reference('saved-for-later') } }
    expect(await resolveDshModelConnection(h.ctx, 'claude', 'sonnet', settings)).toBeUndefined()
    expect(await mappedRoleModels(h.ctx, settings)).toBeUndefined()
    expect(await mappedRoleInfo(h.ctx, settings, 'sonnet')).toBeUndefined()
    expect(h.credentials.resolve).not.toHaveBeenCalled()
    expect(h.llm.resolveModelInfo).not.toHaveBeenCalled()
  })
})
