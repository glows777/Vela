import { expect, test } from 'bun:test'
import * as settings from '../../packages/vela/src/driver/config/settings.ts'
import * as diagnostics from '../../packages/vela/src/driver/diagnostics.ts'
import * as messages from '../../packages/vela/src/driver/messages.ts'
import * as entries from '../../packages/vela/src/driver/session/entries.ts'
import * as ids from '../../packages/vela/src/driver/session/session-id.ts'
import * as selection from '../../packages/vela/src/driver/tools/tool-selection.ts'
import * as catalog from '../../packages/vela/src/providers/models/catalog.ts'
import { BUILTIN_PROVIDERS } from '../../packages/vela/src/providers/models-config.ts'
import {
  createFauxModel,
  fauxText,
} from '../../packages/vela/src/testing/core/index.ts'

const api = diagnostics as unknown as Record<string, unknown>
test('experimental frontend helpers are the canonical core implementations', () => {
  const canonical: Record<string, unknown> = {
    buildSessionPath: entries.buildSessionPath,
    contextEntries: (entries as unknown as Record<string, unknown>)
      .contextEntries,
    summaryMessageText: entries.summaryMessageText,
    branchSummaryMessageText: entries.branchSummaryMessageText,
    sessionContentText: entries.messageText,
    newSessionId: ids.newSessionId,
    THINKING_LEVELS: catalog.THINKING_LEVELS,
    getToolListError: selection.getToolListError,
    isToolContent: messages.isToolContent,
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
  let guidance = ''
  try {
    resolve!(undefined)
  } catch (error) {
    guidance = error instanceof Error ? error.message : String(error)
  }
  expect(guidance).toStartWith('No model available. Sign in with /login')
  // Fails while a provider in BUILTIN_PROVIDERS is missing its key from the message (#390).
  for (const { envKey } of Object.values(BUILTIN_PROVIDERS))
    expect(guidance).toContain(envKey)
})
