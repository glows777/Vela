import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LanguageModelV4, LanguageModelV4Usage } from '@ai-sdk/provider'
import { type LanguageModel, wrapLanguageModel } from 'ai'
import type { VelaEvent } from '../../src/agent/events.ts'
import {
  type Call,
  chars,
  type Evidence,
  grade,
  observedBunTest,
  repetition,
  type ScenarioId,
} from './graders.ts'
import { type Attempt, emptyUsage, pricing } from './report.ts'
import {
  compactionFixture,
  fixtures,
  page,
  previousReport,
  prompts,
} from './scenarios.ts'

export interface WorkerConfig {
  runtime: string
  cwd: string
  artifactDir: string
  scenario: ScenarioId
  arm: 'old' | 'new'
  run: number
  attempt: number
  thinking: string
}
async function load<T>(runtime: string, file: string): Promise<T> {
  return import(pathToFileURL(join(runtime, file)).href)
}
export const errorReason = (error: unknown): string => {
  const item = error as { name?: string; statusCode?: number }
  if (error instanceof Error) {
    if (/^(?:Context|Request) exceeds the safe input size/.test(error.message))
      return 'Context input cap exceeded'
    if (error.message.startsWith('Context still exceeds'))
      return 'Post-summary input cap exceeded'
    if (error.message.startsWith('Summary input exceeds'))
      return 'Summary input cap exceeded'
    if (error.message.startsWith('Context needs a summary'))
      return 'No safe summary boundary'
    if (error.message.startsWith('Summary was not fully generated'))
      return 'Invalid summary response'
    if (error.message.startsWith('Summary does not match'))
      return 'Summary structure invalid'
    if (error.message.startsWith('Summary quotes are not'))
      return 'Summary quotation validation failed'
    if (error.message.startsWith('faux:'))
      return 'Offline model script exhausted'
  }
  // Provider errors may contain request bodies/headers. Never serialize their message, stack or object.
  return `${item?.name ?? 'Error'}${item?.statusCode ? ` HTTP ${item.statusCode}` : ''}`
}
export async function command(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; text: string }> {
  const child = Bun.spawn(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    },
    timeout: 60_000,
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { ok: exit === 0, text: stdout + stderr }
}

/** Internal model injection is for offline product verification, never a CLI model switch. */
export async function runAttempt(
  config: WorkerConfig,
  apiKey?: string,
  injectedModel?: LanguageModel,
): Promise<Attempt> {
  const started = performance.now()
  const evidence: Evidence = {
    answers: [],
    calls: [],
    deliveries: [],
    topics: [],
    compactions: [],
    files: {},
    changed: [],
    validation: {},
  }
  const usage = emptyUsage()
  const result: Attempt = {
    ...config,
    status: 'error',
    checks: [],
    evidence,
    usage,
    durationMs: 0,
    sessionFiles: [],
    finalChars: 0,
    toolCalls: 0,
  }
  await mkdir(config.artifactDir, { recursive: true })
  let writing = Promise.resolve()
  const checkpoint = () => {
    const snapshot = JSON.stringify(usage)
    writing = writing.then(async () => {
      await Bun.write(join(config.artifactDir, 'usage.json'), snapshot)
    })
    return writing
  }
  const collect = (value: LanguageModelV4Usage | undefined) => {
    if (value?.inputTokens.total != null && value.outputTokens.total != null) {
      usage.unknown--
      const input = value.inputTokens.total
      const cached = value.inputTokens.cacheRead ?? 0
      const output = value.outputTokens.total
      usage.input += input
      usage.cached += cached
      usage.output += output
      usage.cost +=
        (Math.max(0, input - cached) * pricing.input +
          cached * pricing.cached +
          output * pricing.output) /
        1_000_000
    }
    void checkpoint()
  }
  const begin = (kind: 'main' | 'summary') => {
    usage.requests++
    usage[kind]++
    // Remains unknown if the call errors, is cancelled, or never reports usage.
    usage.unknown++
    void checkpoint()
  }
  const wrap = (model: LanguageModel) =>
    wrapLanguageModel({
      model: model as LanguageModelV4,
      middleware: {
        specificationVersion: 'v4',
        async wrapGenerate({ doGenerate }) {
          begin('summary')
          const response = await doGenerate()
          collect(response.usage)
          return response
        },
        async wrapStream({ doStream }) {
          begin('main')
          const response = await doStream()
          return {
            ...response,
            stream: response.stream.pipeThrough(
              new TransformStream({
                transform(part, controller) {
                  if (part.type === 'finish') collect(part.usage)
                  controller.enqueue(part)
                },
              }),
            ),
          }
        },
      },
    })
  const { createTestVela } = await load<
    typeof import('../../src/testing/test-vela.ts')
  >(config.runtime, 'src/testing/test-vela.ts')
  const { loadModels } = await load<
    typeof import('../../src/config/models.ts')
  >(config.runtime, 'src/config/models.ts')
  const { velaInternals } = await load<typeof import('../../src/vela.ts')>(
    config.runtime,
    'src/vela.ts',
  )
  const providerDir = join(config.artifactDir, 'provider')
  await mkdir(providerDir, { recursive: true })
  await Bun.write(
    join(providerDir, 'models.json'),
    JSON.stringify({
      providers: {
        eval: {
          api: 'openai-responses',
          baseUrl: 'https://api.deepseek.com',
          apiKey: '$OPENAI_KEY',
          models: [
            {
              id: 'deepseek-flash',
              contextWindow:
                config.scenario === 'C5'
                  ? compactionFixture.contextWindow
                  : 1_000_000,
              reasoning: true,
              thinkingLevelMap: {
                off: 'none',
                minimal: 'low',
                low: 'low',
                medium: 'high',
                high: 'high',
                xhigh: 'high',
                max: 'max',
              },
            },
          ],
        },
      },
    }),
  )
  const providers = loadModels({
    agentDir: providerDir,
    env: apiKey ? { OPENAI_KEY: apiKey } : {},
  })
  const definition = providers.eval!
  const createModel = definition.createModel.bind(definition)
  definition.createModel = (id, context) =>
    wrap(injectedModel ?? createModel(id, context))
  const extensions: NonNullable<
    Parameters<typeof createTestVela>[0]
  >['extensions'] = []
  let server: ReturnType<typeof Bun.serve> | undefined
  let fake:
    | ReturnType<typeof import('../../test/support/feishu.ts')['fakeFeishu']>
    | undefined
  let eventFactory:
    | typeof import('../../test/support/feishu.ts')['feishuEvent']
    | undefined
  if (config.scenario === 'C3') {
    const { web } = await load<
      typeof import('../../src/extensions/web/index.ts')
    >(config.runtime, 'src/extensions/web/index.ts')
    extensions.push(web())
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(page, { headers: { 'Content-Type': 'text/html' } }),
    })
  }
  if (config.scenario.startsWith('G')) {
    const helpers = await load<typeof import('../../test/support/feishu.ts')>(
      config.runtime,
      'test/support/feishu.ts',
    )
    const { feishu } = await load<
      typeof import('../../src/extensions/feishu/index.ts')
    >(config.runtime, 'src/extensions/feishu/index.ts')
    fake = helpers.fakeFeishu()
    eventFactory = helpers.feishuEvent
    extensions.push(
      feishu({
        appId: 'eval-bot',
        owners: ['ou_alice'],
        chats: ['oc_group'],
        transport: fake.transport,
      }),
    )
    if (config.scenario === 'G1')
      fake.history.push(
        helpers.historyMessage(
          'meeting',
          'ou_bob',
          'The release meeting starts at 14:30 UTC.',
          '1000',
        ),
      )
    if (config.scenario === 'G5') {
      evidence.previousReport = previousReport
      const report = helpers.historyMessage(
        'report',
        'ou_bot',
        previousReport,
        '2000',
      )
      report.sender!.sender_type = 'app'
      fake.topicHistory.push([
        helpers.historyMessage(
          'root',
          'ou_alice',
          'Complete the release checklist.',
          '1000',
        ),
        report,
      ])
    }
  }
  const files = fixtures(config.scenario)
  const exitScenario = ['G6', 'G7', 'G8'].includes(config.scenario)
  const topicRoots =
    config.scenario === 'G6'
      ? ['g6_b', 'g6_a']
      : config.scenario === 'G8'
        ? ['g8_store', 'g8_recall']
        : ['g7_store', 'g7_recall']
  const { channelSessionId } = await load<
    typeof import('../../src/channels/session-id.ts')
  >(config.runtime, 'src/channels/session-id.ts')
  const bun = (...args: string[]) =>
    command(config.cwd, [process.execPath, '--no-env-file', ...args])
  const readTask = (path: string) =>
    Bun.file(join(config.cwd, path))
      .text()
      .catch(() => '')
  const t = createTestVela({
    cwd: config.cwd,
    dataDir: join(config.artifactDir, 'data'),
    model: 'eval/deepseek-flash',
    providers,
    thinkingLevel: config.thinking as 'max',
    extensions,
    files: config.scenario === 'G6' ? {} : files,
    // Restore normal backoff: the helper otherwise defaults retryBaseMs to zero. Keep product retries.
    limits: { retryBaseMs: 500 },
    session:
      config.scenario === 'C5'
        ? { tools: ['read_file', 'write_file', 'list_directory'] }
        : undefined,
  })
  let phase = 0
  let channelStarted = false
  let channelError: unknown
  const calls = new Map<string, Call>()
  t.vela.subscribe((event: VelaEvent, sessionId) => {
    if (event.type === 'agent_start' && sessionId.startsWith('feishu-'))
      channelStarted = true
    if (event.type === 'channel_error') channelError = event.error
    if (exitScenario && event.type === 'channel_reply') {
      const topicRootId = topicRoots.find(
        (root) => channelSessionId('feishu', 'oc_group', root) === sessionId,
      )
      evidence.deliveries.push({
        scope: topicRootId ? 'topic' : 'group',
        topicRootId,
        text: event.text.replace(/<at\b[^>]*>.*?<\/at>\s*/g, ''),
      })
    }
    if (event.type === 'compaction_end' && event.result && !event.aborted)
      evidence.compactions.push(phase)
    if (event.type === 'tool_execution_start') {
      const args = { ...(event.args as Record<string, unknown>) }
      if (typeof args.path === 'string')
        args.path = relative(config.cwd, resolve(config.cwd, args.path))
      const call = { name: event.toolName, args, phase, success: false }
      calls.set(event.toolCallId, call)
      evidence.calls.push(call)
    }
    if (event.type === 'tool_execution_end') {
      const call = calls.get(event.toolCallId)
      if (call) {
        call.success = !event.isError
        if (
          call.name === 'bash' &&
          call.success &&
          ['C2', 'C6'].includes(config.scenario)
        )
          call.output = event.result
      }
    }
  })
  const deadline = setTimeout(
    () => {
      channelError = new DOMException(
        'Scenario deadline exceeded',
        'TimeoutError',
      )
      for (const session of t.vela.sessions()) void session.abort(channelError)
    },
    ['C4', 'C5', 'C6'].includes(config.scenario) ? 600_000 : 300_000,
  )
  try {
    // The committed fixtures form the diff baseline, not part of the model's change.
    if (config.scenario !== 'G6' && Object.keys(files).length) {
      await command(config.cwd, ['git', 'add', '--', ...Object.keys(files)])
      const committed = await command(config.cwd, [
        'git',
        '-c',
        'user.name=Vela eval',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.email=eval@localhost',
        'commit',
        '-qm',
        'Seed eval task',
      ])
      if (!committed.ok) throw new Error('Fixture preparation failed')
    }
    await t.vela.ready()
    if (fake && eventFactory) {
      await t.vela.startChannels()
      if (exitScenario) {
        const { groupWorkspace, chatDirectory } = await load<
          typeof import('../../src/channels/scope.ts')
        >(config.runtime, 'src/channels/scope.ts')
        const workspace = groupWorkspace(t.dataDir, 'feishu', 'oc_group')
        for (const [path, content] of Object.entries(files)) {
          await mkdir(dirname(join(workspace, path)), { recursive: true })
          await Bun.write(join(workspace, path), content)
        }
        evidence.inputs = []
        for (const [index, text] of prompts(config.scenario).entries()) {
          phase = index
          channelStarted = false
          const topicRootId = topicRoots[index]!
          evidence.inputs.push({ topicRootId, text })
          fake.deliver(
            eventFactory({
              message_id: `trigger_${topicRootId}`,
              root_id: topicRootId,
              thread_id: `thread_${topicRootId}`,
              create_time: String(3000 + index * 1000),
              content: JSON.stringify({ text: `@_user_1 ${text}` }),
            }),
          )
          while (!channelStarted && !channelError) await Bun.sleep(1)
          const gateway = velaInternals(t.vela).gateway as unknown as {
            queues: Map<string, Promise<void>>
          }
          while (gateway.queues.size && !channelError)
            await Promise.all([...gateway.queues.values()])
          if (channelError) throw channelError
          if (['G7', 'G8'].includes(config.scenario) && index === 0) {
            const { MemoryStore } = await load<
              typeof import('../../src/extensions/memory/store.ts')
            >(config.runtime, 'src/extensions/memory/store.ts')
            // Inspect persisted entries, not tool arguments or MEMORY.md. Snapshot
            // before the fresh topic starts so its writes cannot earn store credit.
            const store = new MemoryStore(
              join(chatDirectory(t.dataDir, 'feishu', 'oc_group'), 'memory'),
            )
            evidence.memoryEntries = store
              .list()
              .map(({ name, content }) => ({ name, content }))
            await Bun.write(
              join(config.artifactDir, 'memory-after-topic-1.json'),
              JSON.stringify(evidence.memoryEntries, null, 2),
            )
          }
        }
        evidence.answers = evidence.deliveries.map((item) => item.text)
      } else {
        fake.deliver(
          eventFactory({
            message_id: 'trigger',
            create_time: '3000',
            mentions:
              config.scenario === 'G3'
                ? []
                : [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
            content: JSON.stringify({
              text: `${config.scenario === 'G3' ? '' : '@_user_1 '}${prompts(config.scenario)[0]}`,
            }),
            ...(['G4', 'G5'].includes(config.scenario)
              ? { root_id: 'root', thread_id: 'thread' }
              : {}),
          }),
        )
        while (!channelStarted && !channelError) await Bun.sleep(1)
        // Both revisions expose the same gateway queue. Drain handoff-created queues too.
        const gateway = velaInternals(t.vela).gateway as unknown as {
          queues: Map<string, Promise<void>>
        }
        while (gateway.queues.size && !channelError)
          await Promise.all([...gateway.queues.values()])
        if (channelError) throw channelError
        evidence.topics = fake.topics.map((topic) => topic.title)
        evidence.deliveries = fake.sent.map((item) => ({
          scope:
            item.messageId === 'trigger' &&
            !['G4', 'G5'].includes(config.scenario)
              ? 'group'
              : 'topic',
          text: item.text.replace(/<at\b[^>]*>.*?<\/at>\s*/g, ''),
        }))
        evidence.answers = evidence.deliveries.map((item) => item.text)
      }
    } else {
      for (const [index, prompt] of prompts(
        config.scenario,
        server?.url.href,
      ).entries()) {
        phase = index
        await t.run(prompt)
        if (channelError) throw channelError
        evidence.answers.push(t.lastAssistantText())
      }
    }
    if (config.scenario === 'C2' || config.scenario === 'C6') {
      const target =
        config.scenario === 'C2' ? 'task/limits.test.ts' : 'task/total.test.ts'
      evidence.validation.testRun = evidence.calls.some(
        (call) =>
          call.name === 'bash' &&
          call.success &&
          observedBunTest(call.output ?? '', target),
      )
      const tested = await bun('test', target)
      evidence.validation.testPassed = tested.ok
      await Bun.write(join(config.artifactDir, 'fixture-test.txt'), tested.text)
      if (config.scenario === 'C2') {
        const content = await readTask(target)
        evidence.validation.expectationUpdated =
          /(?:toBe|toEqual)\(\s*25\s*\)/.test(content)
        const probe = await bun(
          '-e',
          "const m = await import('./task/limits.ts'); if(m.DEFAULT_BATCH_SIZE !== 25) process.exit(1)",
        )
        evidence.validation.testPassed &&= probe.ok
      } else {
        const probe = await bun(
          '-e',
          "const {sumPositive:f}=await import('./task/total.ts');for(const [a,n] of [[[],0],[[2,-3,0,5],7],[[-1,-2],0],[[1,2,3],6]])if(f(Object.freeze(a))!==n)process.exit(1)",
        )
        evidence.validation.module = probe.ok
        const trace = join(config.artifactDir, 'test-inputs.json')
        const preload = join(config.artifactDir, 'test-inputs.ts')
        const modulePath = join(config.cwd, 'task/total.ts')
        // Observe actual test inputs; equivalent array construction, aliases and it() are valid.
        await Bun.write(
          preload,
          `import { mock } from 'bun:test'
import { writeFileSync } from 'node:fs'
const actual = await import(${JSON.stringify(pathToFileURL(modulePath).href)})
const original = actual.sumPositive
const seen = { empty: false, mixed: false, frozen: false }
mock.module(${JSON.stringify(modulePath)}, () => ({ ...actual, sumPositive(numbers) {
  if (Array.isArray(numbers)) {
    seen.empty ||= numbers.length === 0
    seen.mixed ||= numbers.length === 4 && numbers.every((n, i) => n === [2, -3, 0, 5][i])
    seen.frozen ||= Object.isFrozen(numbers)
  }
  writeFileSync(${JSON.stringify(trace)}, JSON.stringify(seen))
  return original(numbers)
} }))
`,
        )
        const traced = await bun('test', '--preload', preload, target)
        await Bun.write(
          join(config.artifactDir, 'fixture-inputs-test.txt'),
          traced.text,
        )
        const seen = await Bun.file(trace)
          .json()
          .catch(() => ({}))
        evidence.validation.tests =
          tested.ok &&
          traced.ok &&
          seen.empty === true &&
          seen.mixed === true &&
          seen.frozen === true
        evidence.validation.doc =
          (await readTask('task/README.md')) ===
          '# Task utilities\nsumPositive ignores nonpositive values.\n'
        evidence.validation.protected =
          (await readTask('task/protected.txt')) === files['task/protected.txt']
      }
    }
    const diff = await command(config.cwd, [
      'git',
      'diff',
      '--name-only',
      'HEAD',
    ])
    const untracked = await command(config.cwd, [
      'git',
      'ls-files',
      '--others',
      '--exclude-standard',
    ])
    evidence.changed = [
      ...new Set(
        `${diff.text}\n${untracked.text}`.trim().split('\n').filter(Boolean),
      ),
    ]
    if (config.scenario === 'C5')
      for (let i = 1; i <= 6; i++)
        evidence.files[`task/step-${i}.txt`] = await readTask(
          `task/step-${i}.txt`,
        )
    result.checks = grade(config.scenario, evidence)
    result.status = result.checks.every((check) => check.pass) ? 'pass' : 'fail'
  } catch (error) {
    result.reason = errorReason(error)
  } finally {
    clearTimeout(deadline)
    await t.cleanup().catch((error) => {
      result.status = 'error'
      result.reason = `Cleanup: ${errorReason(error)}`
    })
    server?.stop(true)
    const sessions = join(config.artifactDir, 'data', 'sessions')
    for (const name of await readdir(sessions).catch(() => []))
      if (name.endsWith('.jsonl'))
        result.sessionFiles.push(
          relative(config.artifactDir, join(sessions, name)),
        )
    result.finalChars = chars(evidence.answers.at(-1) ?? '')
    if (config.scenario === 'C4')
      result.repetition = repetition(evidence.answers)
    result.toolCalls = evidence.calls.length
    result.durationMs = performance.now() - started
    await checkpoint()
    await Bun.write(
      join(config.artifactDir, 'result.json'),
      JSON.stringify(result, null, 2),
    )
  }
  return result
}

if (import.meta.main) {
  const config = JSON.parse(
    await readFile(process.argv[2]!, 'utf8'),
  ) as WorkerConfig
  const secret = await Bun.stdin.text()
  try {
    await runAttempt(config, secret || undefined)
  } catch (error) {
    await Bun.write(
      join(config.artifactDir, 'startup-error.json'),
      JSON.stringify({ reason: errorReason(error) }),
    )
    process.exitCode = 1
  }
}
