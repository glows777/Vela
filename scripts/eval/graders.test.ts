import { expect, test } from 'bun:test'
import { savedGraderAnswers } from './fixtures/saved-grader-answers.ts'
import { savedTestRuns } from './fixtures/saved-test-runs.ts'
import * as graders from './graders.ts'
import { type Evidence, grade, type ScenarioId } from './graders.ts'
import { type Attempt, emptyUsage, table } from './report.ts'
import { compactionFixture, fixtures, prompts } from './scenarios.ts'

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    answers: [],
    calls: [],
    deliveries: [],
    topics: [],
    compactions: [],
    files: {},
    changed: [],
    validation: {},
    ...overrides,
  }
}
const report =
  'Completed the release checklist and archived the deployment evidence for the team.'
const requirements = [
  'launch on 12 November',
  'cap spending at 700 credits',
  'assign the owner to Morgan',
]
const good: Record<ScenarioId, Evidence> = {
  C1: evidence({
    answers: [
      'Other tools default to 3000 characters. **bash**: **2,000** lines or **51,200** bytes.',
    ],
  }),
  C2: evidence({
    answers: ['Updated.'],
    changed: ['task/limits.ts', 'task/limits.test.ts'],
    validation: { testPassed: true, expectationUpdated: true, testRun: true },
  }),
  C3: evidence({ answers: ['It opens at 09:40; admission costs 17 credits.'] }),
  C4: evidence({
    answers: [
      '循环处理输入。',
      '工具错误作为结果返回。',
      '请求按规则重试。',
      '处理输入。执行工具。返回答案。',
    ],
  }),
  C5: evidence({
    answers: [
      'One',
      'Two',
      'Three',
      'Three steps are complete; next is step 4.',
      'Done',
    ],
    compactions: [2],
    files: Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        `task/step-${i + 1}.txt`,
        `step=${i + 1}\n`,
      ]),
    ),
    calls: Array.from({ length: 6 }, (_, i) => ({
      name: 'write_file',
      args: { path: `task/step-${i + 1}.txt` },
      phase: i < 3 ? i : 4,
      success: true,
    })),
  }),
  C6: evidence({
    validation: {
      module: true,
      tests: true,
      testRun: true,
      doc: true,
      protected: true,
    },
    changed: ['task/total.ts', 'task/total.test.ts', 'task/README.md'],
  }),
  G1: evidence({ deliveries: [{ scope: 'group', text: '14:30 UTC' }] }),
  G2: evidence({
    topics: ['Launch brief'],
    calls: [
      {
        name: 'feishu_start_topic',
        args: { title: 'Launch brief', brief: requirements.join('; ') },
        phase: 0,
        success: true,
      },
    ],
  }),
  G3: evidence({
    calls: [{ name: 'feishu_skip_reply', args: {}, phase: 0, success: true }],
  }),
  G4: evidence({
    calls: [
      {
        name: 'feishu_wait_for_input',
        args: { reason: 'Choose a color' },
        phase: 0,
        success: true,
      },
    ],
    deliveries: [{ scope: 'topic', text: 'Blue or green?' }],
  }),
  G5: evidence({
    previousReport: report,
    deliveries: [{ scope: 'topic', text: 'You’re welcome.' }],
  }),
}

for (const [id, input] of Object.entries(good)) {
  test(`${id}: canned passing transcript satisfies every check`, () => {
    expect(grade(id as ScenarioId, input).every((check) => check.pass)).toBe(
      true,
    )
  })
}

function fails(
  id: ScenarioId,
  check: string,
  mutate: (input: Evidence) => void,
) {
  test(`${id}: ${check} rejects its canned failure`, () => {
    const input = structuredClone(good[id])
    mutate(input)
    expect(grade(id, input).find((item) => item.name === check)?.pass).toBe(
      false,
    )
  })
}
for (const saved of savedGraderAnswers) {
  test(`${saved.source}: saved answer satisfies ${saved.check}`, () => {
    const input = structuredClone(good[saved.scenario])
    input.answers[saved.scenario === 'C1' ? 0 : 3] = saved.answer
    expect(
      grade(saved.scenario, input).find((check) => check.name === saved.check)
        ?.pass,
    ).toBe(true)
  })
}
test('C1: incidental bash facts cannot override an explicit incorrect bash section', () => {
  const input = evidence({
    answers: [
      'Other tools: compare bash at 2000 lines / 50KB.\n## bash\n3000 lines / 40KB.',
    ],
  })
  expect(grade('C1', input)[0]?.pass).toBe(false)
})
test.each([
  '2 of 6 steps completed. Next step number: 4.',
  '3 of 6 steps completed. Next step number: 5.',
  '3 steps not completed. Next step number: 4.',
])('C5: incorrect progress remains rejected: %s', (answer) => {
  const input = structuredClone(good.C5)
  input.answers[3] = answer
  expect(
    grade('C5', input).find((check) => check.name === 'progress recalled')
      ?.pass,
  ).toBe(false)
})
fails('C1', 'bash limits', (e) => {
  e.answers = ['bash: 3000 lines / 50KB']
})
fails('C1', 'bash limits', (e) => {
  e.answers = ['bash: 2000 lines / 40KB']
})
fails('C1', 'bash limits', (e) => {
  e.answers = ['read_file: 2000 lines or 50KB; bash is unlimited']
})
test.each([
  ['bash:\n- 最多2000行\n- 最多50KB', true],
  [
    '### **bash**\n\n- 最多 **2000** 行\n- 最多 **50KB**\n### read_file\nOther facts.',
    true,
  ],
  ['bash:\n- 最多2000行\nread_file:\n- 最多50KB', false],
  ['## bash\n- 2000 lines\n## Other tools\n- 50KB', false],
])('C1: section boundaries for %s', (answer, pass) => {
  expect(grade('C1', { ...good.C1, answers: [String(answer)] })[0]?.pass).toBe(
    pass,
  )
})
fails('C2', 'test passes', (e) => {
  e.validation.testPassed = false
})
fails('C2', 'test updated', (e) => {
  e.validation.expectationUpdated = false
})
fails('C2', 'test executed', (e) => {
  e.validation.testRun = false
})
fails('C2', 'allowed diff', (e) => {
  e.changed.push('src/index.ts')
})
fails('C2', 'answer length', (e) => {
  e.answers = ['a'.repeat(601)]
})
fails('C3', 'body facts', (e) => {
  e.answers = ['It opens at 09:40.']
})
fails('C4', 'no repetition', (e) => {
  e.answers[0] =
    'A long explanation about model request retries and error handling.'
  e.answers[1] = e.answers[0]!
})
fails('C4', 'three sentences', (e) => {
  e.answers[3] = 'One. Two. Three. Four.'
})
fails('C4', 'three sentences', (e) => {
  e.answers[3] = ''
})
fails('C5', 'automatic compaction', (e) => {
  e.compactions = []
})
fails('C5', 'automatic compaction', (e) => {
  e.compactions = [4]
})
fails('C5', 'automatic compaction', (e) => {
  e.compactions = [3]
})
fails('C5', 'progress recalled', (e) => {
  e.answers[3] = '2 steps completed; next is step 3.'
})
fails('C5', 'no recreation', (e) => {
  e.calls.push({
    name: 'write_file',
    args: { path: 'task/step-1.txt' },
    phase: 4,
    success: true,
  })
})
fails('C5', 'creation order', (e) => {
  ;[e.calls[0], e.calls[1]] = [e.calls[1]!, e.calls[0]!]
})
fails('C5', 'six files', (e) => {
  e.files['task/step-6.txt'] = 'wrong'
})
for (const name of ['module', 'tests', 'testRun', 'doc', 'protected']) {
  fails('C6', name, (e) => {
    e.validation[name] = false
  })
}
fails('C6', 'allowed diff', (e) => {
  e.changed.push('task/protected.txt')
})
fails('G1', 'no topic', (e) => {
  e.topics.push('Unexpected')
})
fails('G1', 'one short reply', (e) => {
  e.deliveries[0]!.text = 'a'.repeat(301)
})
fails('G1', 'one short reply', (e) => {
  e.deliveries.push({ scope: 'group', text: 'Again' })
})
fails('G2', 'one topic call', (e) => {
  e.calls.push(e.calls[0]!)
})
fails('G2', 'short title', (e) => {
  e.calls[0]!.args.title = 'a'.repeat(41)
})
fails('G2', 'short title', (e) => {
  e.calls[0]!.args.title = 'Two\nlines'
})
for (let i = 0; i < 3; i++) {
  fails('G2', 'complete brief', (e) => {
    e.calls[0]!.args.brief = requirements
      .filter((_, index) => index !== i)
      .join('; ')
  })
}
fails('G2', 'no restating', (e) => {
  e.deliveries.push({ scope: 'group', text: requirements.join('; ') })
})
fails('G3', 'skip called', (e) => {
  e.calls = []
})
fails('G3', 'silent', (e) => {
  e.deliveries.push({ scope: 'group', text: 'OK' })
})
fails('G3', 'silent', (e) => {
  e.topics.push('Unexpected')
})
fails('G4', 'wait called', (e) => {
  e.calls = []
})
fails('G4', 'one question', (e) => {
  e.deliveries[0]!.text = 'Blue? Green?'
})
fails('G4', 'one question', (e) => {
  e.deliveries[0]!.text = 'Choose blue.'
})
fails('G5', 'short acknowledgement', (e) => {
  e.deliveries[0]!.text = 'a'.repeat(81)
})
fails('G5', 'no report repetition', (e) => {
  e.deliveries[0]!.text = report.slice(0, 40)
})

test('exact length boundaries count Unicode code points', () => {
  expect(
    grade('C2', { ...good.C2, answers: ['界'.repeat(600)] }).every(
      (c) => c.pass,
    ),
  ).toBe(true)
  expect(
    grade('G1', {
      ...good.G1,
      deliveries: [{ scope: 'group', text: '😀'.repeat(300) }],
    }).every((c) => c.pass),
  ).toBe(true)
  expect(
    grade('G5', {
      ...good.G5,
      deliveries: [{ scope: 'topic', text: '界'.repeat(80) }],
    }).every((c) => c.pass),
  ).toBe(true)
})
test('overlap normalizes whitespace and starts at exactly thirty characters', () => {
  const span = 'abcdefghijklmno pqrstuvwxyz1234'
  const input = {
    ...good.C4,
    answers: [span, span.replace(' ', '\n   '), 'different', 'Done.'],
  }
  expect(grade('C4', input).find((c) => c.name === 'no repetition')?.pass).toBe(
    false,
  )
  input.answers[1] = span.slice(0, 29)
  expect(grade('C4', input).find((c) => c.name === 'no repetition')?.pass).toBe(
    true,
  )
})
test('sentence counting ignores code and counts numbered items once', () => {
  for (const answer of [
    'One. Two! Three?',
    '一。 二！ 三？',
    '1. First. More detail.\n2. Second.\n3. Third.',
    'One `x.y!` fact. Two. Three.',
  ]) {
    expect(
      grade('C4', {
        ...good.C4,
        answers: [...good.C4.answers.slice(0, 3), answer],
      }).find((c) => c.name === 'three sentences')?.pass,
    ).toBe(true)
  }
})

const sharedThirty = '0123456789ABCDEFGHIJKLMNOPQRST'
test('table data rows retain the character-median cell and align with all eight headings', () => {
  const rows = table([], ['C4', 'C5'], 3)
    .split('\n')
    .filter((line) => line.startsWith('|'))
  const cells = rows.map((row) =>
    row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim()),
  )
  expect(cells[0]).toHaveLength(8)
  for (const row of cells.slice(2)) {
    expect(row).toHaveLength(8)
    expect(row[3]).toBe('—/— (—)')
    expect(row[4]).toBe('— / —')
  }
})
test('C4: metrics count shared Unicode positions once and report every turn and maximum', () => {
  const answers = [
    `${sharedThirty}X`,
    `${sharedThirty}X${'a'.repeat(176)}`,
    'Different.',
    'Done.',
  ]
  const repetition = graders.repetition(answers)
  expect(repetition.turns).toEqual([
    {
      turn: 2,
      answerCodepoints: 207,
      sharedCodepoints: 31,
      percent: (31 / 207) * 100,
    },
    { turn: 3, answerCodepoints: 10, sharedCodepoints: 0, percent: 0 },
    { turn: 4, answerCodepoints: 5, sharedCodepoints: 0, percent: 0 },
  ])
  expect(repetition.maxPercent).toBe((31 / 207) * 100)
  const attempt: Attempt = {
    scenario: 'C4',
    arm: 'old',
    run: 1,
    attempt: 1,
    status: 'pass',
    checks: [],
    evidence: evidence({ answers }),
    usage: emptyUsage(),
    durationMs: 0,
    sessionFiles: [],
    finalChars: 5,
    toolCalls: 0,
    artifactDir: '',
    repetition,
  }
  const output = table([attempt], ['C4'], 1)
  expect(output).toContain('Repeat % old/new (T2/T3/T4; max)')
  expect(output).toContain('14.98/0/0; max 14.98')
})
for (const saved of savedTestRuns) {
  test(`${saved.source}: observes the target test execution after cd`, () => {
    expect(graders.observedBunTest(saved.output, saved.target)).toBe(true)
    expect(
      graders.observedBunTest(saved.output, 'task/unrelated.test.ts'),
    ).toBe(false)
  })
}
test.each([
  'bun test task/limits.test.ts',
  'bun test v1.4.2\n\nlimits.test.ts:\nRan 0 tests across 1 file.',
])(
  'a command mention or zero executed tests is not a test run: %s',
  (output) => {
    expect(graders.observedBunTest(output, 'task/limits.test.ts')).toBe(false)
  },
)
test.each([
  [sharedThirty, `${sharedThirty}${'a'.repeat(170)}`, true],
  [sharedThirty, `${sharedThirty}${'a'.repeat(169)}`, false],
  [`${sharedThirty}X`, `${sharedThirty}X${'a'.repeat(176)}`, true],
  ['😀'.repeat(30), `${'😀'.repeat(30)}${'a'.repeat(170)}`, true],
])(
  'C4: shared-position union at the 15 percent boundary: %s',
  (prior, answer, pass) => {
    const input = evidence({
      answers: [String(prior), String(answer), 'Different.', 'Done.'],
    })
    expect(
      grade('C4', input).find((c) => c.name === 'no repetition')?.pass,
    ).toBe(pass)
  },
)
test('C4: the requested turn-4 summary may repeat earlier turns', () => {
  const input = evidence({
    answers: [sharedThirty, 'Different.', 'Also different.', sharedThirty],
  })
  expect(graders.repetition(input.answers).maxPercent).toBe(100)
  expect(grade('C4', input).find((c) => c.name === 'no repetition')?.pass).toBe(
    true,
  )
})
test('C4: distinct spans shared with different earlier answers both count', () => {
  const other = 'abcdefghijklmnopqrstuvwxyzABCD'
  const input = evidence({
    answers: [
      sharedThirty,
      other,
      `${sharedThirty}${'!'.repeat(140)}${other}`,
      'Done.',
    ],
  })
  expect(grade('C4', input).find((c) => c.name === 'no repetition')?.pass).toBe(
    false,
  )
})
test('C5: ballast is admitted in staged user messages, not paginated notes', () => {
  const staged = prompts('C5')
  const notes = fixtures('C5')
  for (let i = 0; i < 3; i++) {
    expect(staged[i]).toContain('[Inert reference ballast]')
    expect(staged[i]!.length).toBeGreaterThan(
      compactionFixture.paddingBytes[i]!,
    )
    expect(notes[`task/note-${i + 1}.txt`]).not.toContain('Reference')
  }
  expect(staged[3]).toBe(
    'Where were we? State the number of completed steps and the next step number. Do not change files.',
  )
  expect(staged[4]).toBe(
    'Continue and finish the remaining steps in order. Do not recreate completed files.',
  )
})
