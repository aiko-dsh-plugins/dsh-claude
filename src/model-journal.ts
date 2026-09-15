/** Durable, session-owned model request records alongside the Claude sidecar. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createMessage, type ContentBlock, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { DshModelReference } from './model-settings.ts'
import { redactText } from './events.ts'

const ReplayRecord = z.object({ provider: z.string(), model: z.string(), key: z.string(), replayState: z.unknown().optional() }).strict()
const credentialField = /^(?:password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|session[_-]?key)$/i
function auditJson(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => typeof item === 'string'
    ? credentialField.test(key) ? '[REDACTED]' : redactText(item, Number.POSITIVE_INFINITY)
    : item)
}
function keyOf(selected: DshModelReference, content: readonly ContentBlock[]): string {
  const canonical = content.map(block => block.type === 'tool-call' ? { ...block, arguments: JSON.stringify(JSON.parse(block.arguments)) } : block)
  return createHash('sha256').update(JSON.stringify([selected, canonical])).digest('hex')
}

/** Immutable request/response files; replay lookup can only recover provenance for content Claude already supplied. */
export class ModelJournal {
  private readonly path: string
  constructor(sessionId: string, root = dshHomePath('plugins', 'dsh-claude', 'model-requests')) {
    this.path = join(root, createHash('sha256').update(sessionId).digest('hex'))
  }

  /** Persist provider-neutral input before dispatch, redacting credential-like values without truncation.
   * @param requestId - Generated UUID for this provider request.
   * @param cursor - Owning DSH turn and step.
   * @param options - Model-visible input and selected provider controls.
   */
  async request(requestId: string, cursor: { turn: number; step: number }, options: Omit<GenerateOptions, 'signal'>): Promise<void> {
    await mkdir(this.path, { recursive: true, mode: 0o700 })
    await writeFile(join(this.path, `${requestId}.request.json`), auditJson({ ...cursor, options }), { mode: 0o600, flag: 'wx' })
  }

  /** Persist a completed response and its provider-private replay data before acknowledging completion.
   * @param requestId - UUID previously admitted by request().
   * @param selected - Model reference used for the response.
   * @param message - Fully assembled model response.
   */
  async response(requestId: string, selected: DshModelReference, message: Message): Promise<void> {
    await writeFile(join(this.path, `${requestId}.response.json`), auditJson(message), { mode: 0o600, flag: 'wx' })
    const key = keyOf(selected, message.content)
    const replayState = message.source.kind === 'model' ? message.source.replayState : undefined
    const record = { ...selected, key, ...(replayState === undefined ? {} : { replayState }) }
    const encoded = JSON.stringify(record)
    // Altered provider-private replay data is unusable; keep it out of the cache.
    if (auditJson(record) !== encoded) return
    const temporary = join(this.path, `${key}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, encoded, { mode: 0o600, flag: 'wx' })
      await rename(temporary, join(this.path, `${key}.replay.json`))
    } finally { await rm(temporary, { force: true }) }
  }

  /** Recover replay data only for exact incoming history, without adding messages to it.
   * @param selected - Current provider/model pair.
   * @param content - Validated assistant content supplied by Claude's history.
   * @returns Reconstructed message when a matching response exists.
   */
  async replay(selected: DshModelReference, content: ContentBlock[]): Promise<Message | undefined> {
    const key = keyOf(selected, content)
    let raw: string
    try { raw = await readFile(join(this.path, `${key}.replay.json`), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    const saved = ReplayRecord.parse(JSON.parse(raw))
    if (saved.key !== key || saved.provider !== selected.provider || saved.model !== selected.model) throw new Error('Code model replay identity mismatch')
    return createMessage({ role: 'assistant', source: { kind: 'model', ...selected, ...(saved.replayState === undefined ? {} : { replayState: saved.replayState }) }, content })
  }
}
