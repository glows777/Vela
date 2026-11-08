import { expect, test } from 'bun:test'
import { type Evidence, grade, type ScenarioId } from './graders.ts'
import { options } from './run.ts'
import { prompts } from './scenarios.ts'

const evidence = (content: string, answer: string): Evidence => ({
  answers: [answer],
  calls: [],
  deliveries: [],
  topics: [],
  compactions: [],
  files: {},
  changed: [],
  validation: {},
  memoryEntries: [{ name: 'deploy-day', content }],
})

test('M1 grades the persisted correction and fresh-session answer independently', () => {
  const id = 'M1' as ScenarioId
  expect(grade(id, evidence('Deploys happen on Monday.', 'Monday.'))).toEqual([
    { name: 'corrected-note', pass: true },
    { name: 'recall', pass: true },
  ])
  expect(
    grade(id, evidence('Deploys happen on Friday.', 'Monday.'))[0]?.pass,
  ).toBe(false)
  expect(
    grade(id, evidence('Deploys happen on Monday.', 'Friday.'))[1]?.pass,
  ).toBe(false)
  expect(grade(id, evidence('Not Monday, Friday.', 'Monday.'))[0]?.pass).toBe(
    false,
  )
})

test('dream eval is explicit and M1 recall does not leak the correction', () => {
  expect(options(['--only', 'M1,G8', '--dream', 'on']).dream).toBe(true)
  expect(options([]).dream).toBe(false)
  expect(() => options(['--dream', 'maybe'])).toThrow()
  expect(prompts('M1' as ScenarioId)[0]).toContain('Monday')
  expect(prompts('M1' as ScenarioId)[1]).not.toMatch(/Monday|Friday/)
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { command, runAttempt } from './worker.ts'

for (const dream of [false, true]) {
  test(`M1 runs separate sessions, dream=${dream}, and accounts for the isolated call`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'vela-dream-eval-'))
    try {
      const cwd = join(root, 'work')
      await command(root, ['git', 'init', '-q', cwd])
      await command(cwd, [
        'git',
        '-c',
        'user.name=Eval',
        '-c',
        'user.email=eval@localhost',
        '-c',
        'commit.gpgSign=false',
        'commit',
        '--allow-empty',
        '-qm',
        'fixture',
      ])
      const model = createFauxModel({
        responses: [
          fauxText('The deployment calendar changed.'),
          fauxToolCall('memory', {
            action: 'read',
            filename: 'project_deploy-day.md',
          }),
          fauxText(dream ? 'Monday.' : 'Friday.'),
        ],
        generate: dream
          ? [
              fauxText(
                JSON.stringify({
                  ops: [
                    {
                      action: 'update',
                      filename: 'project_deploy-day.md',
                      name: 'deploy-day',
                      description: 'Deploys happen on Monday.',
                      type: 'project',
                      content: 'Deploys happen on Monday.',
                      reason: 'User changed the calendar.',
                      source: 'dream-correction',
                    },
                  ],
                  report: 'Corrected deployment day.',
                }),
              ),
            ]
          : [],
      })
      const result = await runAttempt(
        {
          runtime: resolve(import.meta.dir, '../..'),
          cwd,
          artifactDir: join(root, 'artifacts'),
          scenario: 'M1' as ScenarioId,
          arm: dream ? 'new' : 'old',
          dream,
          run: 1,
          attempt: 1,
          thinking: 'off',
        },
        undefined,
        model,
      )
      expect(result.status).toBe(dream ? 'pass' : 'fail')
      expect(
        model.calls.filter((call) => call.kind === 'generate'),
      ).toHaveLength(dream ? 1 : 0)
      expect(result.usage.summary).toBe(dream ? 1 : 0)
      expect(model.pending()).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
