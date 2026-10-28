import { dirname, relative, resolve } from 'node:path'

export const scenarioIds = [
  'C1',
  'C2',
  'C3',
  'C4',
  'C5',
  'C6',
  'G1',
  'G2',
  'G3',
  'G4',
  'G5',
  'G6',
  'G7',
  'G8',
] as const
export type ScenarioId = (typeof scenarioIds)[number]
export interface Call {
  name: string
  args: Record<string, unknown>
  phase: number
  sessionId?: string
  success: boolean
  output?: unknown
}
export interface Evidence {
  answers: string[]
  calls: Call[]
  deliveries: { scope: 'group' | 'topic'; text: string; topicRootId?: string }[]
  inputs?: { topicRootId: string; text: string }[]
  /** Actual entries snapshotted after topic 1, before topic 2 can write. */
  memoryEntries?: { name: string; content: string }[]
  /** Memory custom messages actually injected into the recall topic. */
  recallMemory?: string[]
  recallPaths?: { workspace: string; artifactDir: string }
  topics: string[]
  compactions: number[]
  files: Record<string, string>
  changed: string[]
  validation: Record<string, boolean>
  previousReport?: string
}
export interface Check {
  name: string
  pass: boolean
}
export const chars = (text: string) => Array.from(text.trim()).length
const normalized = (text: string) => text.replace(/\s+/gu, ' ').trim()

export interface Repetition {
  turns: {
    turn: number
    answerCodepoints: number
    sharedCodepoints: number
    percent: number
  }[]
  maxPercent: number
}
/** Preserve whitespace-normalized matching while counting positions in the actual answer. */
export function repetition(answers: string[]): Repetition {
  const priorWindows = new Set<string>()
  const turns: Repetition['turns'] = []
  for (const [index, answer] of answers.entries()) {
    const original = Array.from(answer.trim())
    const points: { text: string; start: number; end: number }[] = []
    for (const [position, text] of original.entries()) {
      const previous = points.at(-1)
      if (/\s/u.test(text) && previous?.text === ' ')
        previous.end = position + 1
      else
        points.push({
          text: /\s/u.test(text) ? ' ' : text,
          start: position,
          end: position + 1,
        })
    }
    const covered = new Uint8Array(original.length)
    const windows: string[] = []
    for (let start = 0; start <= points.length - 30; start++) {
      const window = points
        .slice(start, start + 30)
        .map((point) => point.text)
        .join('')
      windows.push(window)
      if (priorWindows.has(window))
        covered.fill(1, points[start]!.start, points[start + 29]!.end)
    }
    if (index > 0) {
      const sharedCodepoints = covered.reduce((sum, value) => sum + value, 0)
      turns.push({
        turn: index + 1,
        answerCodepoints: original.length,
        sharedCodepoints,
        percent: original.length
          ? (sharedCodepoints / original.length) * 100
          : 0,
      })
    }
    for (const window of windows) priorWindows.add(window)
  }
  return {
    turns,
    maxPercent: Math.max(0, ...turns.map((turn) => turn.percent)),
  }
}

/** Observe Bun's completed runner output, independent of shell spelling or a preceding cd. */
export function observedBunTest(result: unknown, target: string): boolean {
  const output = resultText(result)
  const basename = target.split('/').at(-1)!
  return (
    /^bun test v/m.test(output) &&
    /^Ran [1-9]\d* tests? across [1-9]\d* files?\./m.test(output) &&
    output.split('\n').some((line) => {
      const name = line.trim()
      return (
        name === `${target}:` ||
        name === `${basename}:` ||
        name.endsWith(`/${target}:`)
      )
    })
  )
}

/** Current model-facing text, or the unchanged baseline's stored preview. */
function resultText(result: unknown): string {
  return typeof result === 'string'
    ? result
    : result &&
        typeof result === 'object' &&
        'kind' in result &&
        result.kind === 'vela-tool-result' &&
        'preview' in result &&
        typeof result.preview === 'string'
      ? result.preview
      : ''
}

const within = (root: string, path: string) => {
  const tail = relative(root, path)
  return (
    tail === '' ||
    (tail !== '..' && !tail.startsWith('../') && !tail.startsWith('/'))
  )
}
const memoryPaths = (e: Evidence) =>
  e.recallPaths
    ? [
        resolve(e.recallPaths.workspace, '../memory'),
        resolve(e.recallPaths.artifactDir, 'data/memory'),
      ]
    : []

/** Inspect demonstrated path references, not a shell sandbox or general shell interpreter. */
function diskPaths(call: Call): string[] {
  if (call.name === 'bash')
    return String(call.args.command ?? '')
      .split(/[\s"'`|;&()<>]+/u)
      .filter(
        (part) =>
          ['.', '..', '.vela-eval', 'sessions'].includes(part) ||
          part.includes('/'),
      )
  return ['read_file', 'grep', 'find', 'list_directory'].includes(call.name) &&
    typeof call.args.path === 'string'
    ? [call.args.path]
    : []
}
function contaminated(call: Call, e: Evidence): boolean {
  return diskPaths(call).some((path) => {
    const absolute = resolve(e.recallPaths?.workspace ?? '.', path)
    if (memoryPaths(e).some((root) => within(root, absolute))) return false
    if (
      /(?:^|\/)(?:\.vela-eval|sessions)(?:\/|$)|(?:feishu|lark)-[^/]*\.jsonl/u.test(
        path,
      )
    )
      return true
    if (!e.recallPaths || within(e.recallPaths.workspace, absolute))
      return false
    return within(dirname(e.recallPaths.artifactDir), absolute)
  })
}
function recallSource(
  call: Call,
  e: Evidence,
  fact: (text: string) => boolean,
): boolean {
  if (!call.success) return false
  const text = resultText(call.output)
  if (call.name === 'memory')
    return (
      ['read', 'search', 'list', 'lint'].includes(String(call.args.action)) &&
      !/^(?:No memories|File not found:|Read failed:)/u.test(text) &&
      fact(text)
    )
  if (call.name === 'lark_search_history') {
    try {
      const history = text ? JSON.parse(text) : call.output
      return (
        Array.isArray(history?.matches) &&
        history.matches.some(
          (match: { text?: unknown }) =>
            typeof match.text === 'string' && fact(match.text),
        )
      )
    } catch {
      return false
    }
  }
  return (
    ['read_file', 'grep'].includes(call.name) &&
    fact(text) &&
    diskPaths(call).some((path) =>
      memoryPaths(e).some((root) =>
        within(root, resolve(e.recallPaths!.workspace, path)),
      ),
    )
  )
}

/** Any longer shared span also contains a shared thirty-codepoint window. */
function overlaps(a: string, b: string): boolean {
  const left = Array.from(normalized(a))
  const right = normalized(b)
  for (let i = 0; i <= left.length - 30; i++)
    if (right.includes(left.slice(i, i + 30).join(''))) return true
  return false
}

function sentences(text: string): number {
  const plain = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
  let count = 0
  const prose: string[] = []
  for (const line of plain.split('\n')) {
    if (/^\s*\d+[.)、]\s+\S/u.test(line)) count++
    else prose.push(line.replace(/^\s*[-*+]\s+/u, ''))
  }
  count += prose
    .join('\n')
    .split(/[。！？.!?]+(?:\s+|$)/u)
    .filter((part) => part.trim()).length
  return count
}
const launch = (text: string) =>
  /12\s*(?:November|Nov\b)|November\s*12/i.test(text)
const budget = (text: string) => /700\s*credits/i.test(text)
const owner = (text: string) => /Morgan/i.test(text)
const requirementFacts = [launch, budget, owner]
const requirementClauses = [
  'launch on 12 November',
  'cap spending at 700 credits',
  'assign the owner to Morgan',
]
const allowed = (paths: string[], names: string[]) =>
  paths.length > 0 && paths.every((path) => names.includes(path))

function bashSection(answer: string): string {
  const lines = answer.replace(/[*`]/g, '').split('\n')
  // An explicit section takes precedence over an incidental prose mention.
  let start = lines.findIndex((line) => /^\s*#{1,6}\s+.*\bbash\b/i.test(line))
  if (start < 0)
    start = lines.findIndex((line) =>
      /^\s*(?:[-+]\s+)?bash\s*[:：]/i.test(line),
    )
  if (start < 0) start = lines.findIndex((line) => /\bbash\b/i.test(line))
  if (start < 0) return ''
  const level = lines[start]!.match(/^\s*(#{1,6})\s+/)?.[1]?.length ?? 6
  const section = [lines[start]!.slice(lines[start]!.search(/\bbash\b/i))]
  for (const line of lines.slice(start + 1)) {
    const heading = line.match(/^\s*(#{1,6})\s+/)?.[1]?.length
    if (
      (heading && heading <= level) ||
      /^\s*(?:[-+]\s+|\d+[.)]\s+)?(?:[a-z]\w*_\w+|other(?:\s+tools)?|其他工具)\s*[:：]/i.test(
        line,
      )
    )
      break
    section.push(line)
  }
  return section.join('\n')
}

export function grade(id: ScenarioId, e: Evidence): Check[] {
  // Normalize routing/tool identifiers only. Paths, arguments, results and saved evidence stay raw.
  e = {
    ...e,
    calls: e.calls.map((call) => ({
      ...call,
      name: call.name.replace(/^feishu_/, 'lark_'),
      sessionId: call.sessionId?.replace(/^feishu-/, 'lark-'),
    })),
  }
  const checks: Check[] = []
  const check = (name: string, pass: boolean) => checks.push({ name, pass })
  const answer = e.answers.at(-1) ?? ''
  const calls = (name: string) =>
    e.calls.filter((call) => call.name === name && call.success)
  const delivered = e.deliveries.map((item) => item.text).join('\n')
  switch (id) {
    case 'C1': {
      // Facts must occur in the bash portion, rather than an unrelated read_file paragraph.
      const bash = bashSection(answer)
      check(
        'bash limits',
        /2[，,]?000\s*(?:lines?|行)/i.test(bash) &&
          /50\s*(?:ki?b|kb)|51[，,]?200\s*(?:bytes?|字节)/i.test(bash),
      )
      break
    }
    case 'C2':
      check('test passes', !!e.validation.testPassed)
      check('test updated', !!e.validation.expectationUpdated)
      check('test executed', !!e.validation.testRun)
      check(
        'allowed diff',
        allowed(e.changed, ['task/limits.ts', 'task/limits.test.ts']),
      )
      check('answer length', chars(answer) <= 600)
      break
    case 'C3':
      check('body facts', /09:40/.test(answer) && /17\s*credits/i.test(answer))
      break
    case 'C4':
      check(
        'no repetition',
        // Turn 4 asks for a summary of turns 1-3, so repeating them there is the task.
        e.answers.length === 4 &&
          repetition(e.answers)
            .turns.filter((turn) => turn.turn < 4)
            .every((turn) => turn.percent <= 15),
      )
      check('three sentences', chars(answer) > 0 && sentences(answer) <= 3)
      break
    case 'C5': {
      const progress = (e.answers[3] ?? '').replace(/[*`]/g, '')
      const writes = calls('write_file').filter((call) =>
        /^task\/step-[1-6]\.txt$/.test(String(call.args.path)),
      )
      check(
        'automatic compaction',
        e.compactions.some((phase) => phase < 3),
      )
      check(
        'progress recalled',
        /(?:3|three|三)\s*(?:of\s+(?:6|six)\s+)?(?:steps?\s*)?(?:are\s+)?(?:complete[ds]?|done|已完成)|(?:complete[ds]?|done|已完成)\D{0,12}(?:3|three|三)/i.test(
          progress,
        ) &&
          /(?:step\s*4\b|第四|第\s*4|next(?:\s+step)?(?:\s+number)?\s*[:：]?\s*(?:is\s+)?4\b|next\D{0,8}4\b)/i.test(
            progress,
          ),
      )
      check(
        'no recreation',
        !e.calls.some(
          (call) =>
            call.phase === 4 &&
            /^(?:write_file|edit_file)$/.test(call.name) &&
            /^task\/step-[1-3]\.txt$/.test(String(call.args.path)),
        ),
      )
      check(
        'creation order',
        writes.map((call) => call.args.path).join(',') ===
          Array.from({ length: 6 }, (_, i) => `task/step-${i + 1}.txt`).join(
            ',',
          ),
      )
      check(
        'six files',
        Array.from(
          { length: 6 },
          (_, i) => e.files[`task/step-${i + 1}.txt`] === `step=${i + 1}\n`,
        ).every(Boolean),
      )
      break
    }
    case 'C6':
      for (const name of ['module', 'tests', 'testRun', 'doc', 'protected'])
        check(name, !!e.validation[name])
      check(
        'allowed diff',
        allowed(e.changed, [
          'task/total.ts',
          'task/total.test.ts',
          'task/README.md',
        ]),
      )
      break
    case 'G1':
      check('no topic', e.topics.length === 0)
      check(
        'one short reply',
        e.deliveries.length === 1 &&
          chars(delivered) > 0 &&
          chars(delivered) <= 300,
      )
      break
    case 'G2': {
      const starts = calls('lark_start_topic')
      const title = String(starts[0]?.args.title ?? '').trim()
      const brief = String(starts[0]?.args.brief ?? '')
      check('one topic call', starts.length === 1)
      check(
        'short title',
        chars(title) > 0 && chars(title) <= 40 && !/[\r\n]/.test(title),
      )
      check(
        'complete brief',
        requirementFacts.every((fact) => fact(brief)),
      )
      check(
        'no restating',
        e.deliveries
          .filter((item) => item.scope === 'group')
          .every(
            ({ text }) =>
              !requirementFacts.some((fact) => fact(text)) &&
              !requirementClauses.some((clause) => overlaps(clause, text)),
          ),
      )
      break
    }
    case 'G3':
      check('skip called', calls('lark_skip_reply').length > 0)
      check('silent', e.deliveries.length === 0 && e.topics.length === 0)
      break
    case 'G4':
      check('wait called', calls('lark_wait_for_input').length > 0)
      check('one question', (delivered.match(/[?？]/g) ?? []).length === 1)
      break
    case 'G5':
      check(
        'short acknowledgement',
        chars(delivered) > 0 && chars(delivered) <= 80,
      )
      check(
        'no report repetition',
        !overlaps(e.previousReport ?? '', delivered),
      )
      break
    case 'G6': {
      const final =
        e.deliveries
          .filter(
            (item) => item.scope === 'topic' && item.topicRootId === 'g6_b',
          )
          .at(-1)?.text ?? ''
      check('B final fact', /(?<![\w-])ORBIT-73(?![\w-])/i.test(final))
      check(
        'no human relay',
        e.inputs?.length === 2 &&
          e.inputs[0]?.topicRootId === 'g6_b' &&
          e.inputs[1]?.topicRootId === 'g6_a',
      )
      break
    }
    case 'G7':
    case 'G8': {
      const fact = (text: string) => /(?<![\w-])kestrel(?![\w-])/i.test(text)
      check('store', !!e.memoryEntries?.some((entry) => fact(entry.content)))
      const final =
        e.deliveries
          .filter(
            (item) =>
              item.scope === 'topic' &&
              item.topicRootId === `${id.toLowerCase()}_recall`,
          )
          .at(-1)?.text ?? ''
      const recallCalls = e.calls.filter(
        (call) =>
          call.phase === 1 &&
          call.sessionId === `lark-oc_group-${id.toLowerCase()}_recall`,
      )
      check(
        'recall',
        fact(final) &&
          !recallCalls.some((call) => contaminated(call, e)) &&
          (!!e.recallMemory?.some(fact) ||
            recallCalls.some((call) => recallSource(call, e, fact))),
      )
      break
    }
  }
  return checks
}
