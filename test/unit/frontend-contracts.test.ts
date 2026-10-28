import { expect, test } from 'bun:test'
import * as diagnostics from '@glows777/vela-core/diagnostics'
import { createFauxModel, fauxText } from '@glows777/vela-core/testing'
import * as paths from '../../packages/core/src/config/paths.ts'
import * as settings from '../../packages/core/src/config/settings.ts'
import * as messages from '../../packages/core/src/messages.ts'
import * as catalog from '../../packages/core/src/models/catalog.ts'
import * as entries from '../../packages/core/src/session/entries.ts'
import * as html from '../../packages/core/src/session/export-html.ts'
import * as options from '../../packages/core/src/session/options.ts'
import * as ids from '../../packages/core/src/session/session-id.ts'
import * as selection from '../../packages/core/src/tools/tool-selection.ts'

const api = diagnostics as unknown as Record<string, unknown>
test('experimental frontend helpers are the canonical core implementations', () => {
  const canonical: Record<string, unknown> = {
    renderSessionHtml: html.renderSessionHtml,
    buildSessionPath: entries.buildSessionPath,
    contextEntries: (entries as unknown as Record<string, unknown>)
      .contextEntries,
    summaryMessageText: entries.summaryMessageText,
    branchSummaryMessageText: entries.branchSummaryMessageText,
    sessionContentText: entries.messageText,
    isSessionV1: entries.isSessionV1,
    newSessionId: ids.newSessionId,
    assertSessionId: options.assertSessionId,
    THINKING_LEVELS: catalog.THINKING_LEVELS,
    isToolModifier: selection.isToolModifier,
    getToolListError: selection.getToolListError,
    isToolContent: messages.isToolContent,
    defaultAgentDir: paths.defaultAgentDir,
    extensionName: (settings as unknown as Record<string, unknown>)
      .extensionName,
    projectTrustRequired: (settings as unknown as Record<string, unknown>)
      .projectTrustRequired,
  }
  for (const [name, value] of Object.entries(canonical)) {
    expect(api[name]).toBeDefined()
    expect(api[name]).toBe(value)
  }
})
test('copied CLI rule files stay deleted', async () => {
  for (const file of [
    'session-html',
    'session-view',
    'tool-result-output',
    'tool-content',
    'session-options',
    'config-helpers',
  ])
    expect(
      await Bun.file(
        new URL(`../../packages/vela/src/cli/${file}.ts`, import.meta.url),
      ).exists(),
    ).toBe(false)
})
test('lightweight model resolution preserves objects, configured defaults and no-model guidance', () => {
  const resolve = api.resolveModel as
    | ((ref: unknown, options?: unknown) => unknown)
    | undefined
  expect(typeof resolve).toBe('function')
  const model = createFauxModel({ responses: [fauxText('unused')] })
  expect(resolve!(model)).toBe(model)
  let created = ''
  const providers = {
    probe: {
      defaultModel: 'chat',
      models: [{ id: 'chat' }],
      createModel(id: string) {
        created = id
        return model
      },
    },
  }
  expect(resolve!(undefined, { providers })).toBe(model)
  expect(created).toBe('chat')
  expect(resolve!('probe/chat', { providers })).toBe(model)
  expect(() => resolve!(undefined)).toThrow(
    'No model available. Sign in with /login',
  )
})
