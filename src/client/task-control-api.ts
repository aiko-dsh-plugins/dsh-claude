import { CLAUDE_TASK_STOP_PATH } from '../constants.ts'
import { PluginRequestError, pluginWrite } from './plugin-transport.ts'

/** Request a Claude task stop; lifecycle notifications settle its displayed state. */
export async function stopClaudeTask(sessionId: string, taskId: string): Promise<void> {
  try {
    await pluginWrite(CLAUDE_TASK_STOP_PATH, 'fast', undefined, {
      query: { sessionId }, json: { taskId }, key: `stop-task:${sessionId}:${taskId}`,
    })
  } catch (error) {
    throw new Error(error instanceof PluginRequestError && error.status === 409 ? 'tasksUnavailable' : 'tasksStopFailed')
  }
}
