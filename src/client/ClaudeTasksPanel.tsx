import { stopClaudeTask } from './task-control-api.ts'
import { useEffect, useMemo, useState } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeActivityEvent, ClaudeTaskInfo } from '../events.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import type { ClaudeClientProjection } from './projection.ts'
import * as styles from './styles.ts'
import { isProjectedTask, isActiveTask, taskKind } from './task-projection.ts'
import { taskTools } from './conversation-sidecar.ts'
import { ClaudeTranscriptToolItem } from './ClaudeActivityNode.tsx'
import { formatTokenCount } from './token-format.ts'

export interface ClaudeTasksPanelInjected {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  closeDetails: () => void
  turn?: number
  sessionId?: string
  stopTask?: (sessionId: string, taskId: string) => Promise<void>
}

export interface ClaudeTasksPanelProps extends ClaudeTasksPanelInjected {
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}

type StatusKey = 'tasksPaused' | 'tasksRunning' | 'tasksCompleted' | 'tasksFailed' | 'tasksStopped' | 'tasksKilled'

const STATUS_LABEL: Record<string, StatusKey> = {
  running: 'tasksRunning',
  paused: 'tasksPaused',
  completed: 'tasksCompleted',
  failed: 'tasksFailed',
  stopped: 'tasksStopped',
  killed: 'tasksKilled',
}

export function visibleTaskGroups(tasks: readonly ClaudeTaskInfo[], dismissedSettledIds: ReadonlySet<string>) {
  const projected = tasks.filter(isProjectedTask)
  return {
    running: projected.filter(task => isActiveTask(task)),
    finished: projected.filter(task => !isActiveTask(task) && !dismissedSettledIds.has(task.taskId)),
  }
}

export function activitiesForTask(activities: readonly ClaudeActivityEvent[], taskId: string) {
  return activities.filter(activity => activity.taskId === taskId)
}

export function tasksForTurn(tasks: readonly ClaudeTaskInfo[], turn: number) {
  return tasks.filter(task => task.originTurn === turn && isProjectedTask(task))
}

export interface TurnTaskSummary {
  state: 'running' | 'failed' | 'completed' | 'stopped'
  count: number
  running: number
  failed: number
  completed: number
}

export function summarizeTurnTasks(tasks: readonly ClaudeTaskInfo[]): TurnTaskSummary | undefined {
  if (tasks.length === 0) return undefined
  const running = tasks.filter(task => isActiveTask(task)).length
  const failed = tasks.filter(task => task.status === 'failed' || task.status === 'killed').length
  const completed = tasks.filter(task => task.status === 'completed').length
  return {
    state: running > 0 ? 'running' : failed > 0 ? 'failed' : completed === tasks.length ? 'completed' : 'stopped',
    count: tasks.length,
    running,
    failed,
    completed,
  }
}

function statusGlyph(status: ClaudeTaskInfo['status']): string {
  if (status === 'paused') return 'Ⅱ'
  if (status === 'running') return '●'
  if (status === 'completed') return '✓'
  if (status === 'stopped') return '–'
  return '×'
}

function formatDuration(ms: number): string {
  if (ms < 1000) return String(Math.max(1, Math.round(ms))) + 'ms'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return String(seconds) + 's'
  const minutes = Math.floor(seconds / 60)
  return String(minutes) + 'm ' + String(seconds % 60) + 's'
}

function taskMeta(task: ClaudeTaskInfo, t: ClaudeTasksPanelInjected['t']): string[] {
  const parts: string[] = []
  if (task.subagentType !== undefined) parts.push(task.subagentType)
  else if (taskKind(task) === 'background' && task.taskType !== undefined) parts.push(task.taskType)
  if (task.usage?.durationMs !== undefined) parts.push(formatDuration(task.usage.durationMs))
  if (task.usage?.totalTokens !== undefined) parts.push(t('tokens', { count: formatTokenCount(task.usage.totalTokens) }))
  if (task.usage?.toolUses !== undefined) parts.push(t('tasksToolUses', { count: task.usage.toolUses }))
  if (task.lastToolName !== undefined) parts.push(t('tasksLastTool', { tool: task.lastToolName }))
  return parts
}

function TaskActivity({ activity, t }: { activity: ClaudeActivityEvent; t: ClaudeTasksPanelInjected['t'] }) {
  return (
    <li style={styles.taskActivityItem}>
      <span style={styles.taskActivityGlyph} aria-hidden="true">{activity.isError === true ? '×' : '›'}</span>
      <div style={styles.taskActivityBody}>
        <p style={styles.taskActivityTitle}>{activity.title ?? activity.kind}</p>
        {activity.summary === undefined ? null : <p style={styles.taskActivitySummary}>{activity.summary}</p>}
        {activity.detail === undefined ? null : (
          <details style={styles.taskActivityDetail}>
            <summary style={styles.taskActivityDetailSummary}>{t('detail')}</summary>
            <pre style={styles.detailCode}>{activity.detail}</pre>
          </details>
        )}
      </div>
    </li>
  )
}

function TaskCard(props: {
  task: ClaudeTaskInfo
  activities: readonly ClaudeActivityEvent[]
  /** The whole stream: a task's tools are addressed to the call that
   *  dispatched it, not to the task, so they carry no taskId to filter on. */
  allActivities: readonly ClaudeActivityEvent[]
  t: ClaudeTasksPanelInjected['t']
  stopTask?: () => Promise<void>
}) {
  const { task, activities, allActivities, t, stopTask } = props
  const tools = useMemo(() => taskTools(allActivities, task.taskId), [allActivities, task.taskId])
  const [activityOpen, setActivityOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<'tasksUnavailable' | 'tasksStopFailed'>()
  useEffect(() => { if (!isActiveTask(task)) setStopping(false) }, [task.status])
  const stop = async (): Promise<void> => {
    if (stopTask === undefined || stopping) return
    setStopping(true)
    setStopError(undefined)
    try { await stopTask() } catch (error) {
      setStopError(error instanceof Error && error.message === 'tasksUnavailable' ? 'tasksUnavailable' : 'tasksStopFailed')
    } finally { setStopping(false) }
  }
  const running = isActiveTask(task)
  const failed = task.status === 'failed' || task.status === 'killed'
  const meta = taskMeta(task, t)
  return (
    <article style={{ ...styles.taskCard, ...(running ? styles.taskCardRunning : {}) }}>
      <div style={styles.taskCardTop}>
        <span className={running ? 'dsh-claude-act-running' : undefined} style={{ ...styles.taskCardGlyph, ...(running ? styles.iconChipRunning : {}), ...(failed ? styles.iconChipError : {}) }} aria-hidden="true">
          {statusGlyph(task.status)}
        </span>
        <div style={styles.taskCardBody}>
          <p style={{ ...styles.taskTitle, ...(failed ? { color: 'var(--dsw-alias-state-error-primary)' } : {}) }}>{task.workflowName ?? task.description}</p>
          <p style={styles.taskStatusLine}>
            <span>{t(taskKind(task) === 'workflow' ? 'tasksWorkflows' : taskKind(task) === 'subagent' ? 'tasksSubagents' : 'tasksBackground')}</span><span aria-hidden="true"> · </span>
            <span>{t(STATUS_LABEL[task.status] ?? 'tasksRunning')}</span>
            {task.backgrounded === true && taskKind(task) !== 'background' ? <><span aria-hidden="true"> · </span><span>{t('tasksBackground')}</span></> : null}
          </p>
        </div>
      </div>
      {running && stopTask !== undefined ? <button type="button" style={styles.taskTextButton} disabled={stopping} onClick={() => { void stop() }}>{t(stopping ? 'tasksStopping' : 'tasksStop')}</button> : null}
      {stopError === undefined ? null : <p role="alert" style={{ ...styles.taskSummary, color: 'var(--dsw-alias-state-error-primary)' }}>{t(stopError)}</p>}
      {meta.length === 0 ? null : <p style={styles.taskMeta}>{meta.join(' · ')}</p>}
      {task.summary === undefined ? null : <p style={styles.taskSummary}>{task.summary}</p>}
      {activities.length === 0 && tools.length === 0 ? null : (
        <div style={styles.taskActivitySection}>
          <button type="button" style={styles.taskTextButton} aria-expanded={activityOpen} onClick={() => setActivityOpen(value => !value)}>
            {activityOpen ? t('tasksHideActivity') : t('tasksViewActivity')}
          </button>
          {/* The tools the task ran, drawn by the same cards as the
              transcript. The lifecycle pings are the fallback: they are raw
              protocol, and only worth showing when there is nothing better. */}
          {!activityOpen ? null : tools.length > 0
            ? <div style={styles.taskToolList}>{tools.map(tool => (
              <ClaudeTranscriptToolItem key={tool.toolUseId} tool={tool} t={t} />
            ))}</div>
            : <ul style={styles.taskActivityList}>{activities.map(activity => (
              <TaskActivity key={`${activity.turn}:${activity.step}:${activity.ordinal}`} activity={activity} t={t} />
            ))}</ul>}
        </div>
      )}
    </article>
  )
}

function GroupHeading(props: { label: string; count: number; collapsed?: boolean; onToggle?: () => void; action?: { label: string; onClick: () => void } }) {
  const { label, count, collapsed, onToggle, action } = props
  const content = <><span>{label}</span><span style={styles.tasksGroupCount}>{count}</span></>
  return (
    <div style={styles.tasksGroupHeading}>
      {onToggle === undefined ? <div style={styles.tasksGroupTitle}>{content}</div> : (
        <button type="button" style={styles.tasksGroupToggle} aria-expanded={!collapsed} onClick={onToggle}>
          <span style={{ ...styles.chevron, ...(collapsed === true ? {} : styles.chevronOpen) }}>›</span>{content}
        </button>
      )}
      {action === undefined ? null : <button type="button" style={styles.taskTextButton} onClick={action.onClick}>{action.label}</button>}
    </div>
  )
}

export function ClaudeTasksPanel({ useClaudeProjection, t, closeDetails, turn, sessionId, stopTask = stopClaudeTask }: ClaudeTasksPanelProps) {
  const projection = useClaudeProjection(value => value)
  const [filter, setFilter] = useState<'all' | 'subagent' | 'workflow' | 'background'>('all')
  const scopedTasks = useMemo(() => (projection.tasks?.tasks ?? []).filter(task => isProjectedTask(task) && (turn === undefined || task.originTurn === turn)), [projection.tasks, turn])
  const tasks = useMemo(() => scopedTasks.filter(task => filter === 'all' || taskKind(task) === filter), [scopedTasks, filter])
  useEffect(() => {
    if (!projection.owned) closeDetails()
  }, [closeDetails, projection.owned])
  useEffect(() => { setDismissedSettledIds(new Set()); setFilter('all') }, [sessionId, turn])
  const [finishedCollapsed, setFinishedCollapsed] = useState(false)
  const [dismissedSettledIds, setDismissedSettledIds] = useState<ReadonlySet<string>>(() => new Set())
  const groups = useMemo(() => visibleTaskGroups(tasks, dismissedSettledIds), [tasks, dismissedSettledIds])
  const taskActivities = useMemo(() => new Map(tasks.map(task => [task.taskId, activitiesForTask(projection.activities, task.taskId)])), [projection.activities, tasks])
  const clearFinished = (): void => setDismissedSettledIds(previous => new Set([
    ...previous,
    ...tasks.filter(task => !isActiveTask(task)).map(task => task.taskId),
  ]))
  if (!projection.owned) return null
  return (
    <div className={styles.detailsCardClass} style={styles.tasksPanel}>
      <style data-dsh-claude-panel-icon-styles>{styles.detailsCardCss}{styles.panelIconButtonCss}</style>
      <div style={styles.tasksHeader}>
        <div>
          <span style={styles.tasksHeading}>{t(turn === undefined ? 'tasksPanel' : 'tasksPanelTurn')}</span>
          {turn === undefined ? null : <span style={styles.tasksTurnMeta}>{t('tasksTurnNumber', { turn })}</span>}
        </div>
        <button type="button" className={styles.panelIconButtonClass} aria-label={t('tasksClose')} onClick={closeDetails}><IconCloseOutline16 /></button>
      </div>
      <div role="group" aria-label={t('tasksFilter')} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '0 16px 12px' }}>
        {(['all', 'subagent', 'workflow', 'background'] as const).map(value => <button type="button" key={value} style={{ ...styles.taskTextButton, padding: '4px 8px', borderRadius: 6, background: filter === value ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' }} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(value === 'all' ? 'tasksAll' : value === 'subagent' ? 'tasksSubagents' : value === 'workflow' ? 'tasksWorkflows' : 'tasksBackground')}</button>)}
      </div>
      <div style={styles.tasksBody}>
        {scopedTasks.some(task => taskKind(task) === 'workflow') ? <p style={styles.taskMeta}>{t('tasksWorkflowProgress')}</p> : null}
        <section aria-label={t('tasksRunning')}>
          <GroupHeading label={t('tasksRunning')} count={groups.running.length} />
          {groups.running.length === 0 ? <p style={styles.tasksGroupEmpty}>{t('tasksNoneRunning')}</p> : (
            <div style={styles.taskCardList}>{groups.running.map(task => <TaskCard key={task.taskId} task={task} activities={taskActivities.get(task.taskId) ?? []} allActivities={projection.activities} t={t} {...(sessionId === undefined ? {} : { stopTask: () => stopTask(sessionId, task.taskId) })} />)}</div>
          )}
        </section>
        <section aria-label={t('tasksSettled')} style={styles.tasksFinishedSection}>
          <GroupHeading
            label={t('tasksSettled')}
            count={groups.finished.length}
            collapsed={finishedCollapsed}
            onToggle={() => setFinishedCollapsed(value => !value)}
            {...(groups.finished.length === 0 ? {} : { action: { label: t('tasksClear'), onClick: clearFinished } })}
          />
          {finishedCollapsed || groups.finished.length === 0 ? null : (
            <div style={styles.taskCardList}>{groups.finished.map(task => <TaskCard key={task.taskId} task={task} activities={taskActivities.get(task.taskId) ?? []} allActivities={projection.activities} t={t} {...(sessionId === undefined ? {} : { stopTask: () => stopTask(sessionId, task.taskId) })} />)}</div>
          )}
        </section>
      </div>
    </div>
  )
}
