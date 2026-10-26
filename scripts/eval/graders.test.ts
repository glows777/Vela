import { expect, test } from 'bun:test'
import { type Evidence, grade, type ScenarioId } from './graders.ts'

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
