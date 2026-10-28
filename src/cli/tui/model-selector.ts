import type { Component } from '@earendil-works/pi-tui'
import type { VelaSession } from '../../core.ts'
import type { Vela } from '../../vela.ts'
import { nextModel, scopedModels } from '../model-cycle.ts'
import { dialogBox, errorMessage } from './components.ts'
import { SearchSelect } from './search-select.ts'
import { selectListTheme } from './theme.ts'

interface ModelHost {
  vela: Vela
  session: VelaSession
  options: { enabledModels?: string[] }
  addNotice(text: string, level?: 'info' | 'warning' | 'error' | 'dim'): void
  dialog<T>(
    build: (done: (value: T) => void) => {
      component: Component
      focus: Component
    },
  ): Promise<T>
  renderHeader(modelOk: boolean): void
  updateBorder(): void
}

function currentModelRef(host: ModelHost): string | undefined {
  try {
    return host.session.modelInfo.ref
  } catch {}
}

/** `/model` and Ctrl+L: pick from the models of providers with a credential, with search (like pi) */
export async function selectModel(host: ModelHost): Promise<void> {
  const current = currentModelRef(host)
  const models = host.vela.models()
  if (!models.length) {
    host.addNotice(
      'No models available: sign in with /login, set a provider API key (e.g. ANTHROPIC_API_KEY), or switch directly with /model provider/id',
      'dim',
    )
    return
  }
  const ref = await host.dialog<string | undefined>((done) => {
    const list = new SearchSelect(
      models.map((m) => ({
        value: m.ref,
        label: m.ref === current ? `${m.ref} ✓` : m.ref,
        description: [
          m.name,
          m.contextWindow && `${Math.round(m.contextWindow / 1000)}k`,
          m.reasoning === false && 'no thinking',
        ]
          .filter(Boolean)
          .join(' · '),
      })),
      10,
      selectListTheme,
      current,
    )
    list.onSelect = (item) => done(item.value)
    list.onCancel = () => done(undefined)
    return {
      component: dialogBox(
        'Select Model',
        list,
        'Type to search · ↑↓ navigate · Enter select · Esc cancel',
      ),
      focus: list,
    }
  })
  if (ref) switchModel(host, ref)
}

function switchModel(host: ModelHost, ref: string): void {
  try {
    host.session.setModel(ref)
    host.addNotice(
      `Model: ${host.session.modelInfo.ref} · thinking: ${host.session.thinkingLevel}`,
      'dim',
    )
    host.renderHeader(true)
  } catch (error) {
    host.addNotice(errorMessage(error), 'error')
  }
  host.updateBorder()
}

/** Ctrl+P / Shift+Ctrl+P (like pi): the next model of settings `enabledModels`, or of all available models */
export function cycleModel(host: ModelHost, direction: 1 | -1): void {
  const models = scopedModels(host.vela.models(), host.options.enabledModels)
  const next = nextModel(models, currentModelRef(host), direction)
  if (!next) {
    host.addNotice(
      models.length
        ? 'Only one model to cycle through (see enabledModels in settings)'
        : 'No models available: sign in with /login or set a provider API key',
      'dim',
    )
    return
  }
  switchModel(host, next.ref)
}
