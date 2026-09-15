import { useSyncExternalStore } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeClientProjection } from './projection.ts'
import type { PanelOpenSource } from './panel-open-store.ts'
import type { ClaudeCodeSettingsKey } from './locales.ts'
import { isProjectedTask, isActiveTask } from './task-projection.ts'
import * as styles from './styles.ts'

/** Open all Claude tasks without changing the native session or composer. */
export function ClaudeTasksHeaderAction({ t, toggleTasks, tasksOpen, useClaudeProjection }: {
  t: (key: ClaudeCodeSettingsKey, params?: Record<string, unknown>) => string
  toggleTasks: () => void
  tasksOpen: PanelOpenSource
  useClaudeProjection: SnapshotSelectorHook<ClaudeClientProjection>
}) {
  const owned = useClaudeProjection(value => value.owned)
  const running = useClaudeProjection(value => value.tasks?.tasks.filter(task => isProjectedTask(task) && isActiveTask(task)).length ?? 0)
  const open = useSyncExternalStore(tasksOpen.subscribe, tasksOpen.getSnapshot, tasksOpen.getSnapshot)
  if (!owned) return null
  const label = t(open ? 'tasksClose' : 'tasksOpen')
  return <Tooltip label={label} side="bottom" delayMs={250}>
    <button type="button" style={{ ...styles.taskTextButton, padding: '6px 10px', borderRadius: 8, background: open ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent' }} aria-label={label} aria-pressed={open} onClick={toggleTasks}>
      {t('tasksPanel')}{running > 0 ? ` · ${running}` : ''}
    </button>
  </Tooltip>
}
