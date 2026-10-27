import { expect, spyOn, test } from 'bun:test'
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
const memoryRead = () => ({
  name: 'memory',
  args: { action: 'read', filename: 'project_staging-server.md' },
  phase: 1,
  sessionId: 'feishu-oc_group-g7_recall',
  success: true,
  output:
    '---\nname: staging-server\n---\nThe staging server is called kestrel.',
})
const report =
  'Completed the release checklist and archived the deployment evidence for the team.'
const requirements = [
  'launch on 12 November',
  'cap spending at 700 credits',
  'assign the owner to Morgan',
]
const good = {
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
  G6: evidence({
    inputs: [
      { topicRootId: 'g6_b', text: 'Wait for A.' },
      { topicRootId: 'g6_a', text: 'Read the fixture.' },
    ],
    deliveries: [{ scope: 'topic', topicRootId: 'g6_b', text: 'ORBIT-73' }],
  }),
  G7: evidence({
    calls: [memoryRead()],
    memoryEntries: [
      { name: 'staging', content: 'The staging server is called kestrel.' },
    ],
    deliveries: [
      { scope: 'topic', topicRootId: 'g7_recall', text: 'Kestrel.' },
    ],
  }),
} satisfies Partial<Record<ScenarioId, Evidence>>

for (const [id, input] of Object.entries(good)) {
  test(`${id}: canned passing transcript satisfies every check`, () => {
    expect(grade(id as ScenarioId, input).every((check) => check.pass)).toBe(
      true,
    )
  })
}

function fails(
  id: keyof typeof good,
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

// Issue #219: these cases were added and run before the exit graders/harness.
const exitEvidence = () =>
  evidence({
    inputs: [
      {
        topicRootId: 'g6_b',
        text: 'Wait for topic A to supply the release code.',
      },
      {
        topicRootId: 'g6_a',
        text: 'Read the fixture and hand its code to topic B.',
      },
    ],
    deliveries: [
      { scope: 'topic', topicRootId: 'g6_b', text: 'The code is ORBIT-73.' },
    ],
  })
test('G6: a B answer with the fixture fact and only the two initial tasks passes', () => {
  expect(grade('G6', exitEvidence())).toEqual([
    { name: 'B final fact', pass: true },
    { name: 'no human relay', pass: true },
  ])
})
test.each(['g6_a', undefined])(
  'G6: fact delivered outside B (%s) does not pass',
  (topicRootId) => {
    const e = exitEvidence()
    e.deliveries[0]!.topicRootId = topicRootId
    expect(grade('G6', e).find((c) => c.name === 'B final fact')?.pass).toBe(
      false,
    )
  },
)
test.each(['I still need the code.', 'ORBIT-730'])(
  'G6: only the final B answer with the exact fact counts: %s',
  (text) => {
    const e = exitEvidence()
    e.deliveries.push({ scope: 'topic', topicRootId: 'g6_b', text })
    expect(grade('G6', e).find((c) => c.name === 'B final fact')?.pass).toBe(
      false,
    )
  },
)
test('G6: a human relay invalidates an otherwise correct B answer', () => {
  const e = exitEvidence()
  e.inputs!.push({ topicRootId: 'g6_b', text: 'ORBIT-73' })
  expect(grade('G6', e).find((c) => c.name === 'no human relay')?.pass).toBe(
    false,
  )
})
test('G6: reversed topic startup is rejected', () => {
  const e = exitEvidence()
  e.inputs!.reverse()
  expect(grade('G6', e).find((c) => c.name === 'no human relay')?.pass).toBe(
    false,
  )
})
test.each([true, false])(
  'G7: store and recall are graded independently (stored=%s)',
  (stored) => {
    const e = evidence({
      calls: [
        {
          ...memoryRead(),
          name: 'feishu_search_history',
          args: {},
          output: JSON.stringify({
            matches: [{ text: 'The staging server is called kestrel.' }],
          }),
        },
      ],
      memoryEntries: stored
        ? [
            {
              name: 'staging',
              content: 'The staging server is called kestrel.',
            },
          ]
        : [],
      deliveries: [
        {
          scope: 'topic',
          topicRootId: 'g7_recall',
          text: stored ? 'I do not know.' : 'Kestrel.',
        },
      ],
    })
    expect(grade('G7', e)).toEqual([
      { name: 'store', pass: stored },
      { name: 'recall', pass: !stored },
    ])
  },
)
test('G7: a real entry and a fresh-topic answer satisfy both predicates', () => {
  const e = evidence({
    calls: [memoryRead()],
    memoryEntries: [
      { name: 'staging', content: 'The staging server is called kestrel.' },
    ],
    deliveries: [
      { scope: 'topic', topicRootId: 'g7_recall', text: 'Kestrel.' },
    ],
  })
  expect(grade('G7', e)).toEqual([
    { name: 'store', pass: true },
    { name: 'recall', pass: true },
  ])
})
test('G7: topic 1, the index/name, and fact substrings cannot satisfy the predicates', () => {
  const e = evidence({
    memoryEntries: [
      { name: 'kestrel', content: 'The server name is unknown.' },
    ],
    deliveries: [
      { scope: 'topic', topicRootId: 'g7_store', text: 'Remembered kestrel.' },
      { scope: 'topic', topicRootId: 'g7_recall', text: 'kestrel-test' },
    ],
  })
  expect(grade('G7', e)).toEqual([
    { name: 'store', pass: false },
    { name: 'recall', pass: false },
  ])
})
test('exit report requires three valid runs and reports G7 components separately', () => {
  const make = (
    run: number,
    store: boolean,
    recall: boolean,
    status: Attempt['status'] = 'fail',
  ): Attempt => ({
    scenario: 'G7',
    arm: 'old',
    run,
    attempt: 1,
    status,
    checks: [
      { name: 'store', pass: store },
      { name: 'recall', pass: recall },
    ],
    usage: emptyUsage(),
    durationMs: 0,
    sessionFiles: [],
    finalChars: 0,
    toolCalls: 0,
    artifactDir: '',
  })
  const attempts = [
    make(1, true, false),
    make(2, true, true, 'pass'),
    make(3, false, false),
  ]
  expect(table(attempts, ['G7'], 3)).toContain(
    'old store: pass (2/3); recall: fail (1/3)',
  )
  attempts[2]!.status = 'error'
  expect(table(attempts, ['G7'], 3)).toContain(
    'old store: incomplete (2/2); recall: incomplete (1/2)',
  )
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createFauxModel,
  type FauxStep,
  fauxError,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import * as feishuHelpers from '../../test/support/feishu.ts'
import { options } from './run.ts'
import * as scenarios from './scenarios.ts'
import { command, runAttempt } from './worker.ts'

const exitRuntime = resolve(import.meta.dir, '../..')
async function exitAttempt(
  scenario: 'G6' | 'G7' | 'G8',
  responses: FauxStep[],
  history = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'vela-exit-eval-test-'))
  const model = createFauxModel({ responses })
  const originalFake = feishuHelpers.fakeFeishu
  const fakeSpy = history
    ? spyOn(feishuHelpers, 'fakeFeishu').mockImplementation(() => {
        const fake = originalFake()
        fake.transport.searchMessages = async () => ({
          items: [
            feishuHelpers.historyMessage(
              'stored',
              'ou_alice',
              prompts(scenario)[0]!,
              '3000',
            ),
          ],
        })
        return fake
      })
    : undefined
  try {
    const cwd = join(root, 'work')
    await command(root, ['git', 'init', '-q', cwd])
    await command(cwd, [
      'git',
      '-c',
      'user.name=Eval test',
      '-c',
      'user.email=eval@localhost',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ])
    const result = await runAttempt(
      {
        runtime: exitRuntime,
        cwd,
        artifactDir: join(root, 'artifacts'),
        scenario,
        arm: 'new',
        run: 1,
        attempt: 1,
        thinking: 'off',
      },
      undefined,
      model,
    )
    const snapshot = await Bun.file(
      join(root, 'artifacts', 'memory-after-topic-1.json'),
    )
      .json()
      .catch(() => undefined)
    return { result, calls: model.calls, pending: model.pending(), snapshot }
  } finally {
    fakeSpy?.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}
const stagingMemory = {
  action: 'save',
  name: 'staging-server',
  description: 'The staging server name',
  type: 'project',
  content: 'The staging server is called kestrel.',
}
test('exit scenarios use the peeled v0.4.0 baseline while legacy scenarios retain OLD_COMMIT', () => {
  expect(scenarios.baselineCommit('G6')).toBe(
    '5b976e26706686a2213f514895d05110f50af2a5',
  )
  expect(scenarios.baselineCommit('G7')).toBe(
    '5b976e26706686a2213f514895d05110f50af2a5',
  )
  for (const id of graders.scenarioIds.filter(
    (id) => id !== 'G6' && id !== 'G7' && id !== 'G8',
  ))
    expect(scenarios.baselineCommit(id)).toBe(scenarios.OLD_COMMIT)
  expect(options([]).runs).toBe(3)
  expect(options(['--only', 'G6,G7']).only).toEqual(['G6', 'G7'])
})
test('G6 worker starts B first, then A reads the real group fixture; no unsupported handoff is fabricated', async () => {
  const { result, calls, pending } = await exitAttempt('G6', [
    fauxText('Waiting for topic A.'),
    fauxToolCall('read_file', { path: 'task/handoff.txt' }),
    fauxText('The code is ORBIT-73, but I cannot hand it to B.'),
  ])
  expect(result.status).toBe('fail')
  expect(result.checks).toEqual([
    { name: 'B final fact', pass: false },
    { name: 'no human relay', pass: true },
  ])
  expect(calls).toHaveLength(3)
  expect(calls[0]!.lastUserText).toContain('topic A')
  expect(calls[0]!.lastUserText).not.toContain('ORBIT-73')
  expect(calls[1]!.lastUserText).toContain('g6_b')
  expect(calls[1]!.lastUserText).not.toContain('ORBIT-73')
  expect(calls[2]!.toolResults[0]!.output).toContain('ORBIT-73')
  expect(result.evidence!.calls[0]!.success).toBe(true)
  expect(result.evidence!.inputs!.map((input) => input.topicRootId)).toEqual([
    'g6_b',
    'g6_a',
  ])
  expect(result.sessionFiles.some((file) => file.includes('g6_b'))).toBe(true)
  expect(result.sessionFiles.some((file) => file.includes('g6_a'))).toBe(true)
  expect(pending).toBe(0)
})
test('G7 worker snapshots real group memory after topic 1 and recalls in an isolated fresh topic', async () => {
  const { result, calls, pending } = await exitAttempt('G7', [
    fauxToolCall('memory', stagingMemory),
    fauxText('Remembered.'),
    fauxToolCall('memory', {
      action: 'read',
      filename: 'project_staging-server.md',
    }),
    fauxText('The staging server is called kestrel.'),
  ])
  expect(result.status).toBe('pass')
  expect(result.checks).toEqual([
    { name: 'store', pass: true },
    { name: 'recall', pass: true },
  ])
  expect(result.evidence!.memoryEntries).toEqual([
    expect.objectContaining({ content: stagingMemory.content }),
  ])
  expect(calls[2]!.lastUserText).toContain('staging-server')
  expect(JSON.stringify(calls[2]!.prompt)).not.toContain('remember it')
  expect(calls[3]!.toolResults[0]!.output).toContain('kestrel')
  expect(result.evidence!.inputs!.map((input) => input.topicRootId)).toEqual([
    'g7_store',
    'g7_recall',
  ])
  expect(result.sessionFiles.some((file) => file.includes('g7_store'))).toBe(
    true,
  )
  expect(result.sessionFiles.some((file) => file.includes('g7_recall'))).toBe(
    true,
  )
  expect(pending).toBe(0)
})
test('G7 worker does not credit a memory written only during recall to topic 1', async () => {
  const { result } = await exitAttempt('G7', [
    fauxText('Remembered kestrel.'),
    fauxToolCall('memory', stagingMemory),
    fauxText('Kestrel.'),
  ])
  expect(result.status).toBe('fail')
  expect(result.checks).toEqual([
    { name: 'store', pass: false },
    { name: 'recall', pass: false },
  ])
})
test.each(['G6', 'G7'] as const)(
  '%s worker reports runtime/model breakage as error, without behavioral grades',
  async (scenario) => {
    const { result } = await exitAttempt(scenario, [
      fauxError('400 offline provider failure'),
    ])
    expect(result.status).toBe('error')
    expect(result.checks).toEqual([])
    expect(result.usage.main).toBeGreaterThan(0)
    expect(result.reason).toBeDefined()
  },
)

test('G6 report uses the two-of-three exit bar and keeps errors incomplete', () => {
  const attempts: Attempt[] = [1, 2, 3].map((run) => ({
    scenario: 'G6',
    arm: 'old',
    run,
    attempt: 1,
    status: run < 3 ? 'pass' : 'fail',
    checks: [],
    usage: emptyUsage(),
    durationMs: 0,
    sessionFiles: [],
    finalChars: 0,
    toolCalls: 0,
    artifactDir: '',
  }))
  expect(table(attempts, ['G6'], 3)).toContain('old exit: pass (2/3)')
  attempts[1]!.status = 'fail'
  expect(table(attempts, ['G6'], 3)).toContain('old exit: fail (1/3)')
  attempts[2]!.status = 'error'
  expect(table(attempts, ['G6'], 3)).toContain('old exit: incomplete (1/2)')
})

test('G8 is selectable, uses v0.4.0, and mentions the durable fact only during the ordinary task', () => {
  expect(graders.scenarioIds).toContain('G8')
  expect(options([]).only).toContain('G8')
  expect(options(['--only', 'G8']).only).toEqual(['G8'])
  expect(scenarios.baselineCommit('G8')).toBe(
    '5b976e26706686a2213f514895d05110f50af2a5',
  )
  expect(prompts('G8')).toEqual([
    "Draft a two-line note for the on-call channel saying tonight's deploy is delayed to 22:00. FYI the staging server got renamed to kestrel last week, so use that name in the note.",
    "What's our staging server called these days?",
  ])
  expect(prompts('G8')[0]).not.toMatch(/remember|memory|save|store/i)
  expect(prompts('G8')[1]).not.toContain('kestrel')
  expect(fixtures('G8')).toEqual({})
})

test.each([
  [true, true],
  [true, false],
  [false, true],
  [false, false],
])('G8 grades store=%s and recall=%s independently', (store, recall) => {
  expect(
    grade(
      'G8',
      evidence({
        calls: [{ ...memoryRead(), sessionId: 'feishu-oc_group-g8_recall' }],
        memoryEntries: store
          ? [{ name: 'staging', content: stagingMemory.content }]
          : [],
        deliveries: [
          {
            scope: 'topic',
            topicRootId: 'g8_recall',
            text: recall ? 'Kestrel.' : 'I do not know.',
          },
        ],
      }),
    ),
  ).toEqual([
    { name: 'store', pass: store },
    { name: 'recall', pass: recall },
  ])
})

test('G8 rejects acknowledgements, filenames, tool arguments, and nonfinal or wrong-topic recall', () => {
  expect(
    grade(
      'G8',
      evidence({
        memoryEntries: [
          { name: 'kestrel', content: 'The server name is unknown.' },
        ],
        calls: [
          { name: 'memory', args: stagingMemory, phase: 0, success: true },
        ],
        answers: ['Kestrel.'],
        deliveries: [
          {
            scope: 'topic',
            topicRootId: 'g8_store',
            text: 'Kestrel deploy at 22:00.',
          },
          { scope: 'group', text: 'Kestrel.' },
          { scope: 'topic', topicRootId: 'g7_recall', text: 'Kestrel.' },
          { scope: 'topic', topicRootId: 'g8_recall', text: 'Kestrel.' },
          { scope: 'topic', topicRootId: 'g8_recall', text: 'I do not know.' },
        ],
      }),
    ),
  ).toEqual([
    { name: 'store', pass: false },
    { name: 'recall', pass: false },
  ])
  expect(grade('G8', evidence())).toEqual([
    { name: 'store', pass: false },
    { name: 'recall', pass: false },
  ])
})

test.each(['kestrel-test', 'kestrels'])(
  'G8 rejects fact substring %s in stored content and recall',
  (text) => {
    expect(
      grade(
        'G8',
        evidence({
          memoryEntries: [{ name: 'staging', content: text }],
          deliveries: [{ scope: 'topic', topicRootId: 'g8_recall', text }],
        }),
      ),
    ).toEqual([
      { name: 'store', pass: false },
      { name: 'recall', pass: false },
    ])
  },
)

test('G8 report counts store and recall separately and excludes errors from valid runs', () => {
  const attempts: Attempt[] = [1, 2, 3].map((run) => ({
    scenario: 'G8',
    arm: 'old',
    run,
    attempt: 1,
    status: run === 2 ? 'pass' : 'fail',
    checks: [
      { name: 'store', pass: run < 3 },
      { name: 'recall', pass: run === 2 },
    ],
    usage: emptyUsage(),
    durationMs: 0,
    sessionFiles: [],
    finalChars: 0,
    toolCalls: 0,
    artifactDir: '',
  }))
  attempts.push(...attempts.map((a) => ({ ...a, arm: 'new' as const })))
  for (const arm of ['old', 'new'])
    expect(table(attempts, ['G8'], 3)).toContain(
      `${arm} store: pass (2/3); recall: fail (1/3)`,
    )
  attempts[2]!.status = 'error'
  expect(table(attempts, ['G8'], 3)).toContain(
    'old store: incomplete (2/2); recall: incomplete (1/2)',
  )
  expect(table(attempts.slice(0, 1), ['G8'], 1)).toContain(
    'old store: incomplete (1/1); recall: incomplete (0/1)',
  )
})

test('G8 worker snapshots actual task memory then recalls in a fresh same-group topic', async () => {
  const { result, calls, pending, snapshot } = await exitAttempt('G8', [
    fauxToolCall('memory', stagingMemory),
    fauxText(
      'Tonight’s kestrel deploy is delayed to 22:00.\nOn-call, please use the new time.',
    ),
    fauxToolCall('memory', {
      action: 'read',
      filename: 'project_staging-server.md',
    }),
    fauxText('The staging server is called kestrel.'),
  ])
  expect(result.status).toBe('pass')
  expect(result.checks).toEqual([
    { name: 'store', pass: true },
    { name: 'recall', pass: true },
  ])
  expect(snapshot).toEqual([
    expect.objectContaining({ content: stagingMemory.content }),
  ])
  expect(result.evidence!.memoryEntries).toEqual(snapshot)
  expect(calls[0]!.lastUserText).toContain(prompts('G8')[0]!)
  expect(calls[3]!.toolResults[0]!.output).toContain('kestrel')
  const recall = JSON.stringify(calls[2]!.prompt)
  expect(recall).toContain(prompts('G8')[1]!)
  expect(recall).not.toContain('22:00')
  expect(recall).not.toContain('got renamed')
  expect(recall).not.toContain('On-call, please use the new time.')
  expect(result.evidence!.inputs!.map((input) => input.topicRootId)).toEqual([
    'g8_store',
    'g8_recall',
  ])
  for (const topic of ['g8_store', 'g8_recall'])
    expect(result.sessionFiles.some((file) => file.includes(topic))).toBe(true)
  expect(result.evidence!.calls.every((call) => call.success)).toBe(true)
  expect(pending).toBe(0)
})

test('G8 worker excludes recall-time memory writes from the topic-1 snapshot', async () => {
  const { result, snapshot, pending } = await exitAttempt('G8', [
    fauxText(
      'Tonight’s kestrel deploy is delayed to 22:00.\nOn-call, please use the new time.',
    ),
    fauxToolCall('memory', stagingMemory),
    fauxText('Kestrel.'),
  ])
  expect(result.status).toBe('fail')
  expect(result.checks).toEqual([
    { name: 'store', pass: false },
    { name: 'recall', pass: false },
  ])
  expect(snapshot).toEqual([])
  expect(result.evidence!.memoryEntries).toEqual([])
  expect(result.evidence!.calls[0]).toMatchObject({
    name: 'memory',
    phase: 1,
    success: true,
  })
  expect(pending).toBe(0)
})

test('G8 worker excludes runtime/model errors from behavioral grades', async () => {
  const { result } = await exitAttempt('G8', [
    fauxError('400 offline provider failure'),
  ])
  expect(result.status).toBe('error')
  expect(result.checks).toEqual([])
  expect(result.usage.main).toBeGreaterThan(0)
  expect(result.reason).toBeDefined()
})

for (const id of ['G7', 'G8'] as const) {
  const sessionId = `feishu-oc_group-${id.toLowerCase()}_recall`
  const recallPaths = {
    workspace: '/tmp/run/attempt/data/channels/feishu-oc_group/workspace',
    artifactDir: '/tmp/run/attempt',
  }
  const recalled = (
    calls: Evidence['calls'] = [],
    extra: Partial<Evidence> = {},
  ) =>
    evidence({
      calls,
      recallPaths,
      deliveries: [
        {
          scope: 'topic',
          topicRootId: `${id.toLowerCase()}_recall`,
          text: 'Kestrel.',
        },
      ],
      ...extra,
    })
  const source = { ...memoryRead(), sessionId }
  const recall = (e: Evidence) =>
    grade(id, e).find((c) => c.name === 'recall')!.pass
  test(`${id}: accepts observed memory reads, memory index, and matched history text`, () => {
    expect(recall(recalled([source]))).toBe(true)
    expect(
      recall(
        recalled([
          {
            ...source,
            name: 'read_file',
            args: { path: '../memory/project_staging-server.md' },
          },
        ]),
      ),
    ).toBe(true)
    expect(
      recall(
        recalled([], {
          recallMemory: [
            'Group memory:\n- [staging](project_staging.md) — The server is called kestrel.',
          ],
        }),
      ),
    ).toBe(true)
    expect(
      recall(
        recalled([
          {
            ...source,
            name: 'feishu_search_history',
            args: { keyword: 'staging' },
            output: JSON.stringify({
              matches: [{ text: 'Our staging server is called kestrel.' }],
            }),
          },
        ]),
      ),
    ).toBe(true)
    expect(
      recall(
        recalled([
          {
            ...source,
            output: { kind: 'vela-tool-result', preview: source.output },
          },
        ]),
      ),
    ).toBe(true)
  })
  const absent = [
    [],
    [
      {
        ...source,
        phase: 0,
        sessionId: `feishu-oc_group-${id.toLowerCase()}_store`,
      },
    ],
    [{ ...source, sessionId: 'another-session' }],
    [{ ...source, success: false }],
    [{ ...source, output: undefined }],
    [
      {
        ...source,
        name: 'bash',
        args: { command: 'echo kestrel ../memory' },
        output: 'kestrel ../memory',
      },
    ],
    [
      {
        ...source,
        args: { action: 'save', content: 'kestrel' },
        output: 'Saved to memory: project_kestrel.md',
      },
    ],
    [{ ...source, output: 'File not found: kestrel.md' }],
    [
      {
        ...source,
        args: { action: 'search', query: 'kestrel' },
        output: 'No memories found for "kestrel".',
      },
    ],
    [
      {
        ...source,
        name: 'feishu_search_history',
        args: { keyword: 'kestrel' },
        output: JSON.stringify({
          matches: [],
          coverage: 'kestrel is not a match',
        }),
      },
    ],
    [
      {
        ...source,
        name: 'feishu_search_history',
        output: JSON.stringify({ matches: [{ text: 'unknown' }] }),
      },
    ],
  ]
  test.each(absent.map((calls, i) => [i, calls] as const))(
    `${id}: no observed source (%s) fails`,
    (_i, calls) => {
      expect(
        recall(
          recalled([...calls], {
            memoryEntries: [{ name: 'staging', content: 'kestrel' }],
          }),
        ),
      ).toBe(false)
    },
  )
  const contaminated = [
    ['bash', { command: 'grep -R kestrel .vela-eval' }],
    ['bash', { command: 'find sessions -name "*.jsonl"' }],
    ['read_file', { path: '../../../sessions/feishu-oc_group-g8_store.jsonl' }],
    ['bash', { command: 'grep -R kestrel ../../../sessions' }],
    [
      'bash',
      { command: 'cat /tmp/run/other-attempt/memory-after-topic-1.json' },
    ],
    [
      'read_file',
      {
        path: '/tmp/run/other-attempt/data/channels/feishu-oc_group/memory/project_staging.md',
      },
    ],
    [
      'grep',
      {
        pattern: 'kestrel',
        path: '/tmp/run/attempt/memory-after-topic-1.json',
      },
    ],
    ['find', { pattern: '*.jsonl', path: '../../../sessions' }],
    ['bash', { command: 'rg kestrel /tmp/.vela-eval/run' }],
    ['bash', { command: 'cd .. && rg kestrel .' }],
    ['bash', { command: 'grep kestrel /tmp/run/other-attempt/result.json' }],
  ] as const
  test.each(contaminated)(
    `${id}: %s artifact reference rejects even with a valid source (%j)`,
    (name, args) => {
      expect(
        recall(
          recalled([
            source,
            {
              name,
              args,
              phase: 1,
              sessionId,
              success: true,
              output: 'kestrel',
            },
          ]),
        ),
      ).toBe(false)
    },
  )
  test(`${id}: failed artifact references still fail; store-topic reads and workspace inspection do not contaminate recall`, () => {
    const call = {
      name: 'read_file',
      args: { path: '/tmp/run/other-attempt/result.json' },
      phase: 1,
      sessionId,
      success: false,
    }
    expect(recall(recalled([source, call]))).toBe(false)
    expect(
      recall(
        recalled([
          source,
          {
            ...call,
            phase: 0,
            sessionId: `feishu-oc_group-${id.toLowerCase()}_store`,
          },
        ]),
      ),
    ).toBe(true)
    expect(
      recall(
        recalled([source, { ...call, name: 'bash', args: { command: 'pwd' } }]),
      ),
    ).toBe(true)
    expect(
      recall(
        recalled([
          source,
          { ...call, args: { path: '../memory/project_staging-server.md' } },
        ]),
      ),
    ).toBe(true)
  })

  test(`${id} worker rejects successful raw-session reads and later memory saves as fail`, async () => {
    const topic = id.toLowerCase()
    const { result, calls, pending } = await exitAttempt(id, [
      fauxText('Kestrel.'),
      fauxToolCall('bash', { command: 'pwd' }),
      fauxToolCall('read_file', {
        path: `../../../sessions/feishu-oc_group-${topic}_store.jsonl`,
      }),
      fauxToolCall('memory', stagingMemory),
      fauxText('Kestrel.'),
    ])
    expect(calls[3]!.toolResults[0]!.output).toContain('kestrel')
    expect(result.evidence!.calls[1]).toMatchObject({
      success: true,
      phase: 1,
      sessionId,
    })
    expect(result.evidence!.calls[1]!.output).toContain('kestrel')
    expect(result.status).toBe('fail')
    expect(result.checks).toEqual([
      { name: 'store', pass: false },
      { name: 'recall', pass: false },
    ])
    expect(result.reason).toBeUndefined()
    expect(pending).toBe(0)
  })
  test(`${id} worker rejects bash grep of the store transcript even after valid memory retrieval`, async () => {
    const { result, calls, pending } = await exitAttempt(id, [
      fauxToolCall('memory', stagingMemory),
      fauxText('Saved.'),
      fauxToolCall('memory', {
        action: 'read',
        filename: 'project_staging-server.md',
      }),
      fauxToolCall('bash', {
        command: `grep -i kestrel ../../../sessions/feishu-oc_group-${id.toLowerCase()}_store.jsonl`,
      }),
      fauxText('Kestrel.'),
    ])
    expect(calls[4]!.toolResults[0]!.output).toContain('kestrel')
    expect(result.evidence!.calls[2]).toMatchObject({
      success: true,
      sessionId,
    })
    expect(result.status).toBe('fail')
    expect(result.checks).toEqual([
      { name: 'store', pass: true },
      { name: 'recall', pass: false },
    ])
    expect(pending).toBe(0)
  })
  test(`${id} worker accepts actual history results and rejects empty history`, async () => {
    for (const history of [true, false]) {
      const { result, calls, pending } = await exitAttempt(
        id,
        [
          fauxText('Done.'),
          fauxToolCall('feishu_search_history', { keyword: 'staging' }),
          fauxText('Kestrel.'),
        ],
        history,
      )
      const output = JSON.parse(calls[2]!.toolResults[0]!.output as string)
      expect(output.matches).toHaveLength(history ? 1 : 0)
      expect(result.evidence!.calls[0]).toMatchObject({
        success: true,
        sessionId,
      })
      expect(result.checks).toEqual([
        { name: 'store', pass: false },
        { name: 'recall', pass: history },
      ])
      expect(result.status).toBe('fail')
      expect(pending).toBe(0)
    }
  })
  test(`${id} worker credits a fact in the actual injected memory index`, async () => {
    const { result, calls } = await exitAttempt(id, [
      fauxToolCall('memory', {
        ...stagingMemory,
        description: 'The staging server is called kestrel.',
      }),
      fauxText('Saved.'),
      fauxText('Kestrel.'),
    ])
    expect(calls[2]!.lastUserText).toContain('kestrel')
    expect(result.evidence!.recallMemory!.join('\n')).toContain('kestrel')
    expect(result.status).toBe('pass')
  })
  test(`${id} worker accepts reading the legitimate group memory file`, async () => {
    const { result, calls } = await exitAttempt(id, [
      fauxToolCall('memory', stagingMemory),
      fauxText('Saved.'),
      fauxToolCall('read_file', {
        path: '../memory/project_staging-server.md',
      }),
      fauxText('Kestrel.'),
    ])
    expect(calls[3]!.toolResults[0]!.output).toContain('kestrel')
    expect(result.status).toBe('pass')
  })
  test(`${id} worker rejects a scripted correct answer without a source`, async () => {
    const { result } = await exitAttempt(id, [
      fauxText('Done.'),
      fauxText('Kestrel.'),
    ])
    expect(result.checks).toEqual([
      { name: 'store', pass: false },
      { name: 'recall', pass: false },
    ])
    expect(result.status).toBe('fail')
  })
}
