import type { Context } from '@deepseek-ai/cordis'
import { CLAUDE_TASK_STOP_PATH } from './constants.ts'
import { PluginBodyTooLargeError, registerPluginRoute } from './http.ts'

/** The authenticated host routes a stop to an observed task, never to a new process. */
export function registerTaskControlRoute(
  ctx: Context,
  stopTask: (sessionId: string, taskId: string) => Promise<boolean>,
  ownsSession: (sessionId: string) => boolean,
): void {
  registerPluginRoute(ctx, {
    mode: 'unary', kind: 'exact', path: CLAUDE_TASK_STOP_PATH, methods: ['POST'], budget: 'fast',
    handler: async io => {
      const sessionId = io.url.searchParams.get('sessionId')
      if (!sessionId || sessionId.length > 1024) return { status: 400, value: { error: 'invalid-session' } }
      if (!ownsSession(sessionId)) return { status: 409, value: { error: 'session-unavailable' } }
      try {
        const body = await io.body<unknown>(4096)
        const taskId = body !== null && typeof body === 'object' && 'taskId' in body ? body.taskId : undefined
        if (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 128) {
          return { status: 400, value: { error: 'invalid-task' } }
        }
        if (io.signal.aborted) return { status: 408, value: { error: 'request-cancelled' } }
        const stopped = await stopTask(sessionId, taskId)
        return stopped ? { status: 200, value: { ok: true } } : { status: 409, value: { error: 'task-unavailable' } }
      } catch (error) {
        if (error instanceof PluginBodyTooLargeError) throw error
        if (error instanceof SyntaxError) return { status: 400, value: { error: 'invalid-json' } }
        return { status: 502, value: { error: 'task-stop-failed' } }
      }
    },
  })
}
