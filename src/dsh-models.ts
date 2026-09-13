/** Resolve DSH model connections for the Claude Code subprocess. Secrets stay in memory. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, type LlmAdapter } from '@deepseek-ai/dsh-llm'
import { Config as DeepSeekConfig, PUBLIC_BASE_URL, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'

/** Intercept Code conversation turns; Cowork and auxiliary requests use their DSH adapter.
 * @param ctx - Host context owning the listener and Agent registry.
 * @param adapter - Claude Code engine bridge.
 */
export function installDshModelRouting(ctx: Context, adapter: Pick<LlmAdapter, 'stream'>): void {
  ctx.on('llm/stream', (options, next) => {
    const agent = options.sessionId === undefined ? ctx.agents.currentInitiator() : ctx.agents.get(options.sessionId)
    if (options.purpose !== undefined || options.provider !== 'deepseek-official'
      || agent === undefined || ctx.agentPresets.composedPreset(agent.ctx) !== 'claude') return next()
    return adapter.stream(options)
  }, { global: true })
}

/** A resolved subprocess connection; never serialized into SDK argv or session records. */
export interface ClaudeModelConnection {
  provider: string
  model: string
  /** In-memory equality token for endpoint, credential, and model changes. */
  revision: string
  env: Readonly<Record<string, string | undefined>>
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
 * @param ctx - Host services that own resolved settings and credential references.
 * @param provider - Selected DSH provider.
 * @param model - Exact selected model id.
 * @returns Frozen connection, or undefined for an explicit native Claude selection.
 */
export async function resolveDshModelConnection(ctx: Context, provider: string, model: string): Promise<ClaudeModelConnection | undefined> {
  if (provider === 'claude') return undefined
  if (provider !== 'deepseek-official') throw new Error(`dsh-claude: provider ${provider} does not expose a supported Claude Code connection`)
  const raw = ctx.get('settings')?.get('llm-deepseek')
  if (raw === undefined) throw new Error('dsh-claude: DSH DeepSeek settings are unavailable')
  const connection = resolveAdapterOptions(DeepSeekConfig(raw), launchEnvironmentOf(ctx))
  if (!connection.models.some(candidate => candidate.id === model)) {
    throw new Error(`dsh-claude: model ${model} is not in the DSH DeepSeek catalog`)
  }
  // The public API silently maps unknown names to Flash. Refuse that ambiguity.
  if (new URL(connection.baseURL).origin === PUBLIC_BASE_URL && ![
    'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp', 'deepseek-flash',
  ].includes(model)) throw new Error(`dsh-claude: model ${model} has no verified DeepSeek Anthropic mapping`)
  const baseURL = deepSeekAnthropicURL(connection.baseURL)
  const credentials = ctx.get('credentials')
  const credential = credentials === undefined
    ? launchEnvironmentOf(ctx).get(connection.apiKeyEnv)
    : await credentials.resolve(connection.apiKeyEnv)
  const apiKey = assertUsableApiKey(credential?.value ?? '', 'dsh-claude', connection.apiKeyEnv)
  const env = Object.freeze({
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: undefined,
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: undefined,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
    ANTHROPIC_CUSTOM_HEADERS: undefined,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    DISABLE_PROMPT_CACHING: '1',
  })
  return Object.freeze({ provider, model, env, revision: createHash('sha256').update(JSON.stringify(env)).digest('hex') })
}
