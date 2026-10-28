import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { apiReport } from '../../../scripts/api-report.ts'

test('core public entries match the API snapshot', async () => {
  const expected = await Bun.file(
    join(import.meta.dir, '../api/public-api.txt'),
  ).text()
  const report = apiReport('core')
  expect(report).toBe(expected)
  for (const name of [
    'inspectVela',
    'inspectSession',
    'VelaInspection',
    'SessionInspection',
    'renderSessionHtml',
    'buildSessionPath',
    'contextEntries',
    'summaryMessageText',
    'branchSummaryMessageText',
    'sessionContentText',
    'isSessionV1',
    'newSessionId',
    'assertSessionId',
    'THINKING_LEVELS',
    'isToolModifier',
    'getToolListError',
    'isToolContent',
    'defaultAgentDir',
    'extensionName',
    'projectTrustRequired',
    'resolveModel',
  ])
    expect(report).toMatch(
      new RegExp(`@experimental\\n  (?:function|interface|const) ${name}\\b`),
    )
}, 60000)
