/** Query-scoped loopback Messages endpoint backed by DSH's registered model adapters. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { DshCapabilityInvocation } from './dsh-capabilities.ts'
import type { DshModelReference } from './model-settings.ts'
import { ModelRequest, toClaudeBlock, toDshRequest } from './model-protocol.ts'
import { ModelJournal } from './model-journal.ts'

const providerDispatch = new AsyncLocalStorage<boolean>()
/** Whether this call is an inner Claude model request, excluded from engine routing. */
export function isDshProviderDispatch(): boolean { return providerDispatch.getStore() === true }

/** Limits owned by the plugin's deployment configuration. */
export interface ModelTransportConfig { maxRequestBytes: number; maxResponseBytes: number; requestTimeoutMs: number }
/** Transport handles owned and disposed by one managed Claude query. */
export interface ModelTransportHandle { env: Readonly<Record<string, string>>; dispose(): Promise<void> }
/** Start only after the supervisor establishes a query's cancellation and Agent ownership. */
export type OpenModelTransport = (current: () => DshCapabilityInvocation | undefined) => Promise<ModelTransportHandle>

async function send(response: ServerResponse, data: Record<string, unknown>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (!response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)) await once(response, 'drain', { signal })
}

/** Create an authenticated local endpoint for exact role mappings; provider credentials stay in DSH.
 * @param ctx - Public LLM and attachment services.
 * @param routes - Frozen Claude alias to DSH model references.
 * @param config - Request, response and time limits.
 * @param journalRoot - Optional deployment directory for the per-session model journal.
 * @returns Deferred transport creation tied to a managed query.
 */
export function modelTransport(ctx: Context, routes: Readonly<Record<string, DshModelReference>>, config: ModelTransportConfig, journalRoot?: string): OpenModelTransport {
  return async current => {
    const token = randomBytes(32).toString('base64url')
    const lifetime = new AbortController()
    const pending = new Set<Promise<void>>()
    const server = createServer((request, response) => {
      const operation = (async () => {
        const supplied = request.headers['x-api-key'] ?? request.headers.authorization?.replace(/^Bearer /, '')
        const authenticated = typeof supplied === 'string' && Buffer.byteLength(supplied) === Buffer.byteLength(token)
          && timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
        if (!authenticated || request.headers.origin !== undefined) { response.writeHead(401).end(); return }
        if (request.method !== 'POST' || !/^\/v1\/messages(?:\?|$)/.test(request.url ?? '')) { response.writeHead(404).end(); return }
        const owner = current()
        if (!owner) { response.writeHead(409).end('No active Code turn'); return }
        const disconnected = new AbortController()
        response.on('close', () => { disconnected.abort() })
        const signal = AbortSignal.any([owner.signal, lifetime.signal, disconnected.signal, AbortSignal.timeout(config.requestTimeoutMs)])
        const abortRead = () => { request.destroy() }
        signal.addEventListener('abort', abortRead, { once: true })
        try {
          const chunks: Buffer[] = []
          let size = 0
          for await (const chunk of request) {
            size += chunk.length
            if (size > config.maxRequestBytes) { response.writeHead(413).end('Code model request exceeds the configured limit'); return }
            chunks.push(Buffer.from(chunk))
          }
          signal.throwIfAborted()
          let decoded: unknown
          try { decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
          catch { response.writeHead(400).end('Invalid Messages JSON'); return }
          const parsed = ModelRequest.safeParse(decoded)
          if (!parsed.success) { response.writeHead(400).end('This Claude model request uses unsupported fields or content'); return }
          const input = parsed.data
          const selected = routes[input.model]
          if (!selected || selected.provider === 'claude') { response.writeHead(400).end('Unknown DSH model mapping'); return }
          const journal = new ModelJournal(String(owner.agent.id), journalRoot)
          const options = await toDshRequest(input, selected, ctx.attachments, blocks => journal.replay(selected, blocks))
          const info = await ctx.llm.resolveModelInfo(selected.provider, selected.model)
          const active = current()
          if (active?.agent !== owner.agent || active.cursor.turn !== owner.cursor.turn || active.cursor.step !== owner.cursor.step) throw new Error('Model request outlived its owning turn')
          const effort = input.thinking?.type === 'disabled' ? 'off' : input.output_config?.effort
          if (effort !== undefined && info.reasoning?.efforts.some(item => String(item.id) === effort)) options.reasoningEffort = ReasoningEffortId(effort)
          // An unsupported effort uses the selected provider's published default, not a Claude-specific spelling.
          const requestId = randomUUID()
          const cursor = { turn: owner.cursor.turn, step: owner.cursor.step }
          await journal.request(requestId, cursor, options)
          signal.throwIfAborted()
          const assembled = new BlockAssembler()
          const states = new Map<number, { kind: string; text: string; closed?: boolean }>()
          const id = `msg_${requestId}`
          const initial = { id, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
          if (input.stream) {
            response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
            await send(response, { type: 'message_start', message: initial }, signal)
          }
          let outputBytes = 0
          let finished = false
          await providerDispatch.run(true, async () => {
            for await (const chunk of ctx.llm.stream({ ...options, signal })) {
              outputBytes += Buffer.byteLength(JSON.stringify(chunk))
              if (outputBytes > config.maxResponseBytes) throw new Error('Response limit exceeded')
              assembled.push(chunk)
              if (chunk.type === 'finish') finished = true
              if (!input.stream || chunk.type === 'usage' || chunk.type === 'finish' || chunk.type === 'block-start') continue
              const index = chunk.index
              let state = states.get(index)
              const start = async (kind: string, block: Record<string, unknown>) => {
                state = { kind, text: '' }; states.set(index, state)
                await send(response, { type: 'content_block_start', index, content_block: block }, signal)
              }
              const delta = async (value: string) => {
                state!.text += value
                await send(response, { type: 'content_block_delta', index, delta: state!.kind === 'tool-call'
                  ? { type: 'input_json_delta', partial_json: value } : state!.kind === 'reasoning'
                    ? { type: 'thinking_delta', thinking: value } : { type: 'text_delta', text: value } }, signal)
              }
              if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
                if (!state) await start(chunk.type === 'text-delta' ? 'text' : 'reasoning', chunk.type === 'text-delta' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '', signature: '' })
                await delta(chunk.text)
              } else if (chunk.type === 'tool-call-delta') {
                if (!state) {
                  if (!chunk.name) throw new Error('Tool name missing from first delta')
                  await start('tool-call', { type: 'tool_use', id: chunk.id, name: chunk.name, input: {} })
                }
                if (chunk.argumentsDelta) await delta(chunk.argumentsDelta)
              } else if (chunk.type === 'block-end') {
                if (!state) await start(chunk.block.type, toClaudeBlock(chunk.block))
                else {
                  const complete = chunk.block.type === 'text' || chunk.block.type === 'reasoning' ? chunk.block.text : chunk.block.type === 'tool-call' ? chunk.block.arguments : undefined
                  if (complete === undefined || !complete.startsWith(state.text)) throw new Error('Model output disagrees with streamed content')
                  if (complete.length > state.text.length) await delta(complete.slice(state.text.length))
                }
                if (state!.kind === 'reasoning') await send(response, { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: '' } }, signal)
                await send(response, { type: 'content_block_stop', index }, signal)
                state!.closed = true
              }
            }
          })
          if (!finished) throw new Error('DSH provider ended without a finish event')
          const reason = assembled.finish.kind
          if (reason !== 'stop' && reason !== 'tool-calls' && reason !== 'max-tokens') throw new Error('DSH model did not complete')
          const message = assembled.message({ kind: 'model', ...selected, ...(assembled.replayState === undefined ? {} : { replayState: assembled.replayState }) })
          await journal.response(requestId, selected, message)
          const tokens = assembled.usage
          const usage = { input_tokens: tokens?.inputTokens ?? 0, output_tokens: tokens?.outputTokens ?? 0, cache_read_input_tokens: tokens?.cacheReadTokens ?? 0, cache_creation_input_tokens: tokens?.cacheWriteTokens ?? 0 }
          const stop_reason = reason === 'tool-calls' ? 'tool_use' : reason === 'max-tokens' ? 'max_tokens' : 'end_turn'
          if (input.stream) {
            for (const [index, state] of states) if (!state.closed) await send(response, { type: 'content_block_stop', index }, signal)
            await send(response, { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage }, signal)
            await send(response, { type: 'message_stop' }, signal)
            response.end()
          } else response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ...initial, content: message.content.map(toClaudeBlock), stop_reason, usage }))
        } catch {
          // Provider diagnostics may contain credentials; return a fixed failure, never a raw exception.
          const error = { type: 'error', error: { type: signal.aborted ? 'timeout_error' : 'api_error', message: signal.aborted ? 'DSH model request cancelled or timed out' : 'DSH model request failed; check the selected provider and its supported capabilities' } }
          if (response.headersSent && !response.destroyed) response.end(`event: error\ndata: ${JSON.stringify(error)}\n\n`)
          else if (!response.destroyed) response.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify(error))
        } finally { signal.removeEventListener('abort', abortRead) }
      })()
      pending.add(operation)
      void operation.finally(() => pending.delete(operation)).catch(() => { response.destroy() })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Code model transport failed to bind')
    return {
      env: Object.freeze({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: token }),
      async dispose() {
        lifetime.abort()
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        await Promise.allSettled(pending)
      },
    }
  }
}
