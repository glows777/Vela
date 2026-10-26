import type { ScenarioId } from './graders.ts'

export const OLD_COMMIT = '7fac1dfd6b06e003a990d17867c10090b6f8efc2'
// Shared by both arms. Calibration uses real assembly with canned model responses, not live calls.
export const compactionFixture = {
  version: 'user-ballast-v3',
  contextWindow: 40_000,
  // Preserve pressure before turn 3, but let the checkpoint remove more ballast
  // with the completed first step instead of retaining it through continuation.
  paddingBytes: [19_456, 1_024, 47_104, 0, 0, 0],
}
export const previousReport =
  'Completed the release checklist and archived the deployment evidence for the team. The documentation is updated and the handover is complete.'
export const page =
  '<nav>Home | Events | Subscribe | Archive</nav><main><h1>Observatory visit</h1><p>The observatory opens at 09:40.</p><p>Admission costs 17 credits.</p></main><footer>Contact | Terms | Newsletter | Previous exhibitions</footer>'

export function prompts(id: ScenarioId, url = ''): string[] {
  switch (id) {
    case 'C1':
      return [
        'Vela 的工具结果超过多长会被存到文件、只给模型一段预览？默认上限是多少，在哪个文件定义？bash 的结果也一样吗？',
      ]
    case 'C2':
      return [
        'Change DEFAULT_BATCH_SIZE in task/limits.ts from 20 to 25, update its existing test in task/limits.test.ts, and run that test. Change only these two files.',
      ]
    case 'C3':
      return [
        `According to ${url}, when does the observatory open and what does admission cost?`,
      ]
    case 'C4':
      return [
        'Vela 的 agent 循环代码在哪？简单说下一轮是怎么跑的。',
        '那工具调用失败了会怎么处理？',
        '模型请求失败呢，有重试吗？',
        '好的。用三句话总结一下我们刚才聊的。',
      ]
    case 'C5':
      return [
        'Complete six steps in order. Step N: read task/note-N.txt, then create task/step-N.txt containing exactly "step=N\\n" (replace N with its number). Never recreate completed files. Do step 1 now and pause. Do not do any later step until asked.',
        'Do the next step only, then pause.',
        'Do the next step only, then pause.',
        'Where were we? State the number of completed steps and the next step number. Do not change files.',
        'Continue and finish the remaining steps in order. Do not recreate completed files.',
      ].map((prompt, index) =>
        index < 3
          ? `${prompt}\n\n[Inert reference ballast]\n${ballast(index)}\n[/Inert reference ballast]`
          : prompt,
      )
    case 'C6':
      return [
        'Fulfill all six requirements: (1) Create task/total.ts exporting sumPositive(numbers: readonly number[]): number, summing only positive numbers, returning 0 for an empty input and never mutating the input. (2) Create task/total.test.ts covering empty input and [2,-3,0,5], including frozen input. (3) Run that test with Bun. (4) Append exactly one line "sumPositive ignores nonpositive values." to task/README.md. (5) Do not touch task/protected.txt. (6) Change only task/total.ts, task/total.test.ts and task/README.md.',
      ]
    case 'G1':
      return ['What time is the release meeting?']
    case 'G2':
      return [
        'Prepare a launch brief with these requirements: launch on 12 November; cap spending at 700 credits; assign the owner to Morgan.',
      ]
    case 'G3':
      return ['I brought sandwiches; see you in the kitchen.']
    case 'G4':
      return [
        'Prepare the release banner. The only unresolved decision is whether its background is blue or green; I have no preference. Ask me to choose before proceeding.',
      ]
    case 'G5':
      return ['Thanks']
  }
}

export function fixtures(id: ScenarioId): Record<string, string> {
  if (id === 'C2')
    return {
      'task/limits.ts': 'export const DEFAULT_BATCH_SIZE = 20\n',
      'task/limits.test.ts':
        "import { expect, test } from 'bun:test'\nimport { DEFAULT_BATCH_SIZE } from './limits.ts'\ntest('default batch size', () => expect(DEFAULT_BATCH_SIZE).toBe(20))\n",
    }
  if (id === 'C5')
    return Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        `task/note-${i + 1}.txt`,
        `Step ${i + 1}: create task/step-${i + 1}.txt with step=${i + 1} followed by a newline.\n`,
      ]),
    )
  if (id === 'C6')
    return {
      'task/README.md': '# Task utilities\n',
      'task/protected.txt': 'Leave this file unchanged.\n',
    }
  return {}
}

function ballast(index: number): string {
  return Array.from(
    { length: 1000 },
    (_, line) =>
      `Reference ${line}: item alpha beta gamma delta epsilon zeta eta theta.\n`,
  )
    .join('')
    .slice(0, compactionFixture.paddingBytes[index])
}
