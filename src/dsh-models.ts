/** Resolve DSH model connections for the Claude Code subprocess. Secrets stay in memory. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, type LlmAdapter, type LlmModelInfo, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { Config as DeepSeekConfig, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { CLAUDE_MODEL_ROLES, modelRole, type ClaudeModelRole, type ClaudeModelSettings, type DshModelReference } from './model-settings.ts'
import type { GlobalSettingOption } from './global-settings.ts'
import { isDshProviderDispatch, modelTransport, type ModelTransportConfig, type OpenModelTransport } from './model-transport.ts'

/** Intercept Code conversation turns; Cowork and auxiliary requests use their DSH adapter.
 * @param ctx - Host context owning the listener and Agent registry.
 * @param adapter - Claude Code engine bridge.
 * @param settings - Model source for routing auxiliary titles through the mapped Haiku model.
 */
export function installDshModelRouting(ctx: Context, adapter: Pick<LlmAdapter, 'stream'>, settings?: () => Promise<ClaudeModelSettings>): void {
  ctx.on('llm/stream', (options, next) => {
    if (isDshProviderDispatch()) return next()
    if (settings !== undefined && options.provider === 'claude' && options.purpose === 'session-title') {
      return (async function* () {
        const config = await settings()
        if (config.source === 'native') { yield* next(); return }
        const selection = resolveRoleSelection(ctx, config, 'haiku')
        yield* ctx.llm.stream({ ...options, ...selection })
      })()
    }
    const agent = options.sessionId === undefined ? ctx.agents.currentInitiator() : ctx.agents.get(options.sessionId)
    if (options.purpose !== undefined || options.provider === 'claude'
      || agent === undefined || ctx.agentPresets.composedPreset(agent.ctx) !== 'claude') return next()
    return adapter.stream(options)
  }, { global: true })
}

/** Read the registered model providers used by Cowork, excluding this engine itself.
 * @param ctx - Host LLM registry.
 * @returns Model references and labels without endpoint or credential data.
 */
export async function listDshModelOptions(ctx: Context): Promise<GlobalSettingOption[]> {
  const models = (await Promise.all(ctx.llm.listProviders().filter(provider => provider.id !== 'claude').map(provider => ctx.llm.listModels(provider.id)))).flat()
  return models.map(model => ({
    value: JSON.stringify({ provider: model.provider, model: model.id }),
    label: `${model.name} · ${model.id}`,
    source: 'configured',
  }))
}

/** Resolve a role's saved reference or the live DSH default.
 * @param ctx - Host default-model service.
 * @param settings - Validated role mappings.
 * @param role - Claude model family.
 * @returns Exact provider and model ID.
 */
export function resolveRoleSelection(ctx: Context, settings: ClaudeModelSettings, role: ClaudeModelRole): DshModelReference {
  const selected = settings.roles[role] ?? ctx.get('agentDefaultModel')?.currentSelection()
  if (selected === undefined || selected.provider === 'claude') throw new Error(`dsh-claude: configure a supported DSH model for ${role}`)
  return { provider: selected.provider, model: selected.model }
}

/** Model catalog for the three mapped Claude roles, or native CLI discovery.
 * @param ctx - Host model registry and default selection.
 * @param settings - Current model source.
 * @returns Mapped role rows in DSH mode; undefined delegates to Claude discovery.
 */
export async function mappedRoleModels(ctx: Context, settings: ClaudeModelSettings): Promise<readonly LlmModelInfo[] | undefined> {
  if (settings.source === 'native') return undefined
  return Promise.all(CLAUDE_MODEL_ROLES.map(async role => {
    const selected = resolveRoleSelection(ctx, settings, role)
    const info = await ctx.llm.resolveModelInfo(selected.provider, selected.model)
    return { provider: 'claude', id: role, name: role[0]!.toUpperCase() + role.slice(1), description: `${info.name} · ${selected.model}`, ...(info.inputModalities === undefined ? {} : { inputModalities: info.inputModalities }) }
  }))
}

/** Resolve mapped role capabilities from the same provider used by Cowork.
 * @param ctx - Host model registry.
 * @param settings - Current model source.
 * @param model - Claude role alias.
 * @returns DSH capabilities under the selected alias, or undefined for native mode.
 */
export async function mappedRoleInfo(ctx: Context, settings: ClaudeModelSettings, model: string): Promise<LlmResolvedModelInfo | undefined> {
  if (settings.source === 'native') return undefined
  const selected = resolveRoleSelection(ctx, settings, modelRole(model))
  const info = await ctx.llm.resolveModelInfo(selected.provider, selected.model)
  const role = modelRole(model)
  return { ...info, provider: 'claude', id: model, name: role[0]!.toUpperCase() + role.slice(1), description: `${info.name} · ${selected.model}` }
}

/** A resolved subprocess connection; never serialized into SDK argv or session records. */
export interface ClaudeModelConnection {
  provider: string
  model: string
  /** In-memory equality token for endpoint, credential, and model changes. */
  revision: string
  env: Readonly<Record<string, string | undefined>>
  /** Optional DSH provider transport, opened and closed with the managed query. */
  openTransport?: OpenModelTransport
}

/** Preserve a configured endpoint's origin and path when selecting its Anthropic API.
 * @param baseURL - DSH DeepSeek endpoint.
 * @returns Same-origin Anthropic endpoint. Custom endpoints must expose that API.
 */
export function deepSeekAnthropicURL(baseURL: string): string {
  const url = new URL(baseURL)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('dsh-claude: DeepSeek base URL must be an HTTP endpoint without credentials, query, or fragment')
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
  url.pathname = path.endsWith('/anthropic') ? path : `${path}/anthropic`
  return url.toString().replace(/\/$/, '')
}

/** Resolve one DSH selection without falling back to the user's Claude account.
 * Catalog entries are advisory; the configured endpoint resolves the exact model id.
 * @param ctx - Host services that own resolved settings and credential references.
 * @param provider - Selected DSH provider.
 * @param model - Exact selected model id.
 * @param settings - Optional role mappings; absent preserves direct provider selection.
 * @param transportConfig - Limits for other DSH providers and mixed-provider role mappings.
 * @returns Frozen connection, or undefined for an explicit native Claude selection.
 */
export async function resolveDshModelConnection(ctx: Context, provider: string, model: string, settings?: ClaudeModelSettings, transportConfig?: ModelTransportConfig): Promise<ClaudeModelConnection | undefined> {
  if (settings?.source === 'native' || (provider === 'claude' && settings === undefined)) return undefined
  const roles = settings === undefined ? undefined : Object.fromEntries(CLAUDE_MODEL_ROLES.map(role => [role, resolveRoleSelection(ctx, settings, role)])) as Record<ClaudeModelRole, DshModelReference>
  if (provider === 'claude') {
    const selected = roles![modelRole(model)]
    provider = selected.provider
    model = selected.model
  }
  if (provider !== 'deepseek-official' || Object.values(roles ?? {}).some(role => role.provider !== 'deepseek-official')) {
    if (!transportConfig) throw new Error(`dsh-claude: provider ${provider} requires the DSH model transport`)
    const routes = Object.freeze({ 'aiko-dsh-selected': { provider, model },
      ...Object.fromEntries(CLAUDE_MODEL_ROLES.map(role => [`aiko-dsh-${role}`, roles?.[role] ?? { provider, model }])) })
    for (const selected of Object.values(routes)) await ctx.llm.resolveModelInfo(selected.provider, selected.model)
    const env = Object.freeze({ ...isolatedModelEnvironment(), ANTHROPIC_MODEL: 'aiko-dsh-selected',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'aiko-dsh-haiku', ANTHROPIC_DEFAULT_SONNET_MODEL: 'aiko-dsh-sonnet', ANTHROPIC_DEFAULT_OPUS_MODEL: 'aiko-dsh-opus', ANTHROPIC_SMALL_FAST_MODEL: 'aiko-dsh-haiku' })
    return Object.freeze({ provider, model: 'aiko-dsh-selected', env, revision: createHash('sha256').update(JSON.stringify(routes)).digest('hex'), openTransport: modelTransport(ctx, routes, transportConfig) })
  }
  const raw = ctx.get('settings')?.get('llm-deepseek')
  if (raw === undefined) throw new Error('dsh-claude: DSH DeepSeek settings are unavailable')
  const connection = resolveAdapterOptions(DeepSeekConfig(raw), launchEnvironmentOf(ctx))
  const baseURL = deepSeekAnthropicURL(connection.baseURL)
  const credentials = ctx.get('credentials')
  const credential = credentials === undefined
    ? launchEnvironmentOf(ctx).get(connection.apiKeyEnv)
    : await credentials.resolve(connection.apiKeyEnv)
  const apiKey = assertUsableApiKey(credential?.value ?? '', 'dsh-claude', connection.apiKeyEnv)
  const env = Object.freeze({
    ...isolatedModelEnvironment(),
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: roles?.opus.model ?? model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: roles?.sonnet.model ?? model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: roles?.haiku.model ?? model,
    ANTHROPIC_SMALL_FAST_MODEL: roles?.haiku.model ?? model,
    CLAUDE_CODE_SUBAGENT_MODEL: roles === undefined ? model : undefined,
  })
  return Object.freeze({ provider, model, env, revision: createHash('sha256').update(JSON.stringify(env)).digest('hex') })
}

/** Clear inherited native-account routing before selecting DSH-managed model access. */
function isolatedModelEnvironment() {
  return { ANTHROPIC_BASE_URL: undefined, ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: undefined,
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: undefined, CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined, ANTHROPIC_CUSTOM_HEADERS: undefined, CLAUDE_CODE_SUBAGENT_MODEL: undefined,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', DISABLE_PROMPT_CACHING: '1',
    ENABLE_TOOL_SEARCH: 'false' }
}
