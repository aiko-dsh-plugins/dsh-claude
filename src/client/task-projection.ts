import type { ClaudeActivityEvent, ClaudeTaskInfo } from '../events.ts'

/** Tasks UI is reserved for detached work and genuine Claude subagents. */
export function isProjectedTask(task: ClaudeTaskInfo): boolean {
  if (task.ambient === true) return false
  if (taskKind(task) !== 'background') return true
  if (task.backgrounded === true) return true
  return task.subagentType !== undefined && task.subagentType.trim().length > 0
}

/** Classification uses engine metadata, never a model-written task description. */
export function taskKind(task: ClaudeTaskInfo): 'workflow' | 'subagent' | 'background' {
  if (task.taskType === 'local_workflow' || task.taskType === 'workflow') return 'workflow'
  if (task.taskType === 'local_agent' || task.taskType === 'subagent' || task.subagentType?.trim()) return 'subagent'
  return 'background'
}

/** A paused workflow still owns unfinished work. */
export function isActiveTask(task: ClaudeTaskInfo): boolean {
  return task.status === 'running' || task.status === 'paused'
}

export function isProjectedTaskActivity(
  activity: ClaudeActivityEvent,
  tasks: readonly ClaudeTaskInfo[],
): boolean {
  if (activity.kind !== 'subagent' || activity.parentToolUseId !== undefined) return true
  if (activity.taskId === undefined) return false
  const task = tasks.find(candidate => candidate.taskId === activity.taskId)
  return task !== undefined && isProjectedTask(task)
}
