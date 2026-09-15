// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeModelSettingsCard, type GlobalSettingView } from '../src/client/ClaudeCodeSettings.tsx'
import { en, zh } from '../src/client/locales.ts'

describe('model configuration card', () => {
  it.each(['dsh', 'native'] as const)('renders the %s configuration in both locales', source => {
    const settings: GlobalSettingView[] = ['modelSource', 'modelHaiku', 'modelSonnet', 'modelOpus'].map(key => ({
      key, kind: 'select', effect: 'next-turn', value: key === 'modelSource' ? source : 'default',
      options: key === 'modelSource'
        ? ['dsh', 'native'].map(value => ({ value, label: value, source: 'built-in' }))
        : [{ value: 'default', label: 'default', source: 'built-in' }],
    }))
    for (const dictionary of [en, zh]) {
      const container = document.createElement('div')
      container.innerHTML = renderToStaticMarkup(<ClaudeModelSettingsCard settings={settings} busy={false} t={key => dictionary[key]} onChange={vi.fn()} onRefresh={vi.fn()} />)
      const controls = [...container.querySelectorAll('button[aria-haspopup]')].map(button => ({ label: button.getAttribute('aria-label'), value: button.textContent }))
      expect(controls).toHaveLength(source === 'native' ? 1 : 4)
      expect({ controls, help: container.querySelector('section > p')?.textContent }).toMatchSnapshot()
    }
  })
})
