/** Claude Messages protocol conversion for the public DSH model service. */
import { z } from 'zod'
import { createMessage, createUserMessage, createToolResultMessage, ToolCallId, type ContentBlock, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { DshModelReference } from './model-settings.ts'

const text = z.object({ type: z.literal('text'), text: z.string() })
const image = z.object({ type: z.literal('image'), source: z.object({ type: z.literal('base64'), media_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), data: z.string().base64() }) })
const content = z.discriminatedUnion('type', [text, image,
  z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string().optional() }),
  z.object({ type: z.literal('tool_use'), id: z.string().min(1), name: z.string().min(1), input: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('tool_result'), tool_use_id: z.string().min(1), content: z.union([z.string(), z.array(z.discriminatedUnion('type', [text, image]))]).optional(), is_error: z.boolean().optional() }),
])

/** Accepted client-tool Messages requests. Provider-hosted tools and forced tool selection fail explicitly. */
export const ModelRequest = z.object({
  model: z.string().min(1), max_tokens: z.number().int().positive(), stream: z.boolean().optional(),
  system: z.union([z.string(), z.array(text)]).optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(content)]) })).min(1),
  tools: z.array(z.object({ name: z.string().min(1), description: z.string().optional(), input_schema: z.record(z.string(), z.unknown()), type: z.literal('custom').optional() })).optional(),
  tool_choice: z.object({ type: z.literal('auto'), disable_parallel_tool_use: z.literal(false).optional() }).optional(),
  temperature: z.number().min(0).max(1).optional(), stop_sequences: z.array(z.string()).optional(),
  thinking: z.object({ type: z.enum(['enabled', 'adaptive', 'disabled']), budget_tokens: z.number().int().positive().optional() }).optional(),
  output_config: z.object({ effort: z.string().optional() }).strict().optional(),
  // These transport hints do not alter model content. Unknown top-level semantic features fail below.
  metadata: z.record(z.string(), z.unknown()).optional(), cache_control: z.unknown().optional(),
  context_management: z.unknown().optional(), service_tier: z.string().optional(),
}).strict()

/** Validated Claude request accepted by the DSH transport. */
export type ModelRequest = z.infer<typeof ModelRequest>

/** Convert a validated request, retaining ordered tool results and durable image references.
 * @param request - Parsed Claude Messages request.
 * @param selected - Captured DSH provider/model mapping.
 * @param attachments - Host attachment validation and storage.
 * @param replay - Lookup of prior response provenance from this session.
 * @returns Provider-neutral request with no credentials or transport headers.
 */
export async function toDshRequest(request: ModelRequest, selected: DshModelReference, attachments: AttachmentStore, replay: (blocks: ContentBlock[]) => Promise<Message | undefined>): Promise<GenerateOptions> {
  const convert = async (blocks: z.infer<typeof content>[]): Promise<ContentBlock[]> => {
    const images = blocks.filter(block => block.type === 'image')
    const refs = images.length === 0 ? [] : [...await attachments.saveImages(images.map(block => ({ mediaType: block.source.media_type, data: Buffer.from(block.source.data, 'base64') })))]
    const result: ContentBlock[] = []
    for (const block of blocks) {
      switch (block.type) {
        case 'text': result.push({ type: 'text', text: block.text }); break
        case 'thinking': result.push({ type: 'reasoning', text: block.thinking }); break
        case 'image': result.push({ type: 'image', attachment: refs.shift()! }); break
        case 'tool_use': result.push({ type: 'tool-call', id: ToolCallId(block.id), name: block.name, arguments: JSON.stringify(block.input) }); break
        case 'tool_result': result.push({ type: 'tool-result', toolCallId: ToolCallId(block.tool_use_id), content: await convert(typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : block.content ?? []), ...(block.is_error === undefined ? {} : { isError: block.is_error }) }); break
      }
    }
    return result
  }
  const messages: Message[] = []
  for (const item of request.messages) {
    const blocks = await convert(typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : item.content)
    if (item.role === 'assistant') {
      const previous = await replay(blocks)
      messages.push(previous ?? createMessage({ role: 'assistant', source: { kind: 'model', ...selected }, content: blocks }))
    } else {
      let pending: ContentBlock[] = []
      const flush = () => { if (pending.length) messages.push(createUserMessage({ source: { kind: 'user' }, content: pending })); pending = [] }
      for (const block of blocks) {
        if (block.type !== 'tool-result') { pending.push(block); continue }
        flush()
        messages.push(createToolResultMessage({ callId: block.toolCallId, content: block.content, isError: block.isError ?? false }))
      }
      flush()
    }
  }
  return { ...selected, messages, maxTokens: request.max_tokens,
    ...(request.system === undefined ? {} : { system: typeof request.system === 'string' ? request.system : request.system.map(block => block.text).join('\n') }),
    ...(request.tools === undefined ? {} : { tools: request.tools.map(tool => ({ name: tool.name, description: tool.description ?? '', parameters: tool.input_schema })) }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.stop_sequences === undefined ? {} : { stop: request.stop_sequences }),
  }
}

/** Convert assembled DSH output to Claude client-tool blocks.
 * @param block - Complete model output block.
 * @returns Messages content block, rejecting unsupported output without dropping it.
 */
export function toClaudeBlock(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'thinking', thinking: block.text, signature: '' }
    case 'tool-call': return { type: 'tool_use', id: block.id, name: block.name, input: JSON.parse(block.arguments) }
    default: throw new Error(`Unsupported model output block: ${block.type}`)
  }
}
