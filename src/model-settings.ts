/** Model-source settings contain references only; DSH owns endpoints and credentials. */
export const CLAUDE_MODEL_ROLES = ['haiku', 'sonnet', 'opus'] as const
export type ClaudeModelRole = typeof CLAUDE_MODEL_ROLES[number]
export type ClaudeModelSource = 'dsh' | 'native'
export interface DshModelReference { provider: string; model: string }
export interface ClaudeModelSettings {
  source: ClaudeModelSource
  roles: Partial<Record<ClaudeModelRole, DshModelReference>>
}

/** Decode a saved reference without treating the advisory catalog as a whitelist.
 * @param value - Serialized provider/model pair from plugin settings.
 * @returns Validated model reference.
 */
export function parseModelReference(value: unknown): DshModelReference {
  if (typeof value !== 'string') throw new Error('dsh-claude: invalid DSH model reference')
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('dsh-claude: invalid DSH model reference')
  const ref = parsed as Record<string, unknown>
  if (Object.keys(ref).some(key => key !== 'provider' && key !== 'model')
    || typeof ref.provider !== 'string' || ref.provider.trim().length === 0 || ref.provider === 'claude'
    || typeof ref.model !== 'string' || ref.model.trim().length === 0) {
    throw new Error('dsh-claude: select a DSH model with a supported provider connection')
  }
  return { provider: ref.provider, model: ref.model }
}

/** Read validated model settings from the plugin document.
 * @param document - Parsed plugin settings, without Claude credentials.
 * @returns Source and optional role mappings; missing mappings follow the DSH default.
 */
export function modelSettingsFrom(document: Record<string, unknown>): ClaudeModelSettings {
  const source = document.modelSource ?? 'dsh'
  if (source !== 'dsh' && source !== 'native') throw new Error('dsh-claude: invalid model source')
  const roles: ClaudeModelSettings['roles'] = {}
  for (const role of CLAUDE_MODEL_ROLES) {
    const value = document[`model${role[0]!.toUpperCase()}${role.slice(1)}`]
    if (value !== undefined && value !== 'default') roles[role] = parseModelReference(value)
  }
  return { source, roles }
}

/** Resolve Claude's stable role aliases, including their context-window suffix.
 * @param model - Selected Claude alias.
 * @returns Role used for the DSH mapping.
 */
export function modelRole(model: string): ClaudeModelRole {
  if (model === 'default') return 'sonnet'
  const bare = model.replace(/\[1m\]$/, '')
  if (bare === 'haiku' || bare === 'sonnet' || bare === 'opus') return bare
  throw new Error('dsh-claude: DSH mode supports Haiku, Sonnet and Opus; select a role or use native Claude mode')
}
