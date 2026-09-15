// @vitest-environment jsdom
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeTasksPanel, summarizeTurnTasks } from '../src/client/ClaudeTasksPanel.tsx'
import { ClaudeTaskLauncher } from '../src/client/ClaudeActivityTail.tsx'
import { ClaudeTasksHeaderAction } from '../src/client/ClaudeTasksHeaderAction.tsx'
import { ClaudeDiffPanel } from '../src/client/ClaudeDiffPanel.tsx'
import { PanelOpenStore } from '../src/client/panel-open-store.ts'
import { EMPTY_CLAUDE_PROJECTION, type ClaudeClientProjection } from '../src/client/projection.ts'
import { en, zh } from '../src/client/locales.ts'

const projection: ClaudeClientProjection = {
  ...EMPTY_CLAUDE_PROJECTION, owned: true,
  tasks: { tasks: [
    { taskId: 'wf', taskType: 'local_workflow', workflowName: 'Review changes', description: 'Review', status: 'paused', originTurn: 2, summary: 'Checking two modules' },
    { taskId: 'reader', subagentType: 'Explore', description: 'Read source', status: 'running', originTurn: 2 },
    { taskId: 'old', backgrounded: true, description: 'Earlier command', status: 'completed', originTurn: 1 },
    { taskId: 'watcher', taskType: 'local_agent', ambient: true, description: 'Invisible watcher', status: 'running', originTurn: 2 },
  ] },
}

const useProjection = <T,>(select: (value: ClaudeClientProjection) => T): T => select(projection)

describe('native task panel', () => {
  it('reports an intentional stop separately from a failed task', () => {
    const tasks = [{ taskId: 'stop', description: 'Stopped task', status: 'stopped' as const, originTurn: 1, backgrounded: true }]
    expect(summarizeTurnTasks(tasks)).toMatchObject({ state: 'stopped', failed: 0, completed: 0 })
    const markup = renderToStaticMarkup(<ClaudeTaskLauncher tasks={tasks} turn={1} openTasks={vi.fn()} t={(key, params) => en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name]))} />)
    expect(markup).toContain('1 stopped, 0 completed')
    expect(markup).not.toContain('failed')
  })
  it('keeps Diff open with an explanation for a workspace without Git', () => {
    const container = document.createElement('div')
    container.innerHTML = renderToStaticMarkup(<ClaudeDiffPanel t={key => en[key]} sessionId="session" closeDetails={vi.fn()} useClaudeProjection={select => select({ ...projection, repository: { status: 'not-repository', cwd: '/workspace' } })} />)
    expect(container.querySelector('[role="status"]')?.textContent).toBe(en.diffNotRepository)
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(en.diffClose)
  })
  it('renders localized workflow state and progress alongside subagents, excluding housekeeping', () => {
    for (const dictionary of [en, zh]) {
      const container = document.createElement('div')
      container.innerHTML = renderToStaticMarkup(<ClaudeTasksPanel t={key => dictionary[key]} useClaudeProjection={useProjection} closeDetails={vi.fn()} sessionId="session" />)
      expect(container.textContent).not.toContain('Invisible watcher')
      expect(container.textContent).toContain(dictionary.tasksPaused)
      expect(container.textContent).toContain('Checking two modules')
      expect({
        controls: [...container.querySelectorAll('button')].map(button => button.textContent || button.getAttribute('aria-label')),
        tasks: [...container.querySelectorAll('article')].map(card => card.textContent),
      }).toMatchSnapshot()
    }
  })

  it('filters without closing the panel and sends stop only for the selected task', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const close = vi.fn()
    const stop = vi.fn(async () => { throw new Error('tasksUnavailable') })
    try {
      await act(async () => root.render(<ClaudeTasksPanel t={key => en[key]} useClaudeProjection={useProjection} closeDetails={close} sessionId="session" stopTask={stop} />))
      const click = async (label: string) => {
        const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)
        expect(button).toBeDefined()
        await act(async () => button!.click())
      }
      await click('Workflows')
      expect(container.querySelectorAll('article')).toHaveLength(1)
      await click('Stop task')
      expect(stop).toHaveBeenCalledWith('session', 'wf')
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(en.tasksUnavailable)
      expect(container.textContent).toContain('Paused')
      await click('Background')
      expect(container.textContent).toContain('Earlier command')
      expect(close).not.toHaveBeenCalled()
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('keeps per-turn launchers scoped and hides the header action for Cowork', () => {
    const markup = renderToStaticMarkup(<ClaudeTasksPanel t={key => en[key]} useClaudeProjection={useProjection} closeDetails={vi.fn()} turn={2} />)
    expect(markup).not.toContain('Earlier command')
    const props = { t: (key: keyof typeof en) => en[key], toggleTasks: vi.fn(), tasksOpen: new PanelOpenStore().sourceFor('session') }
    expect(renderToStaticMarkup(<ClaudeTasksHeaderAction {...props} useClaudeProjection={useProjection} />)).toContain(' · 2')
    expect(renderToStaticMarkup(<ClaudeTasksHeaderAction {...props} useClaudeProjection={select => select(EMPTY_CLAUDE_PROJECTION)} />)).toBe('')
  })
})
