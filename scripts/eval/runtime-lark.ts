import { mkdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ProviderDefinition } from '../../packages/vela/src/providers/models/index.ts'
import type { Call, Evidence, ScenarioId } from './graders.ts'
import {
  burstDiscussion,
  fixtures,
  previousReport,
  prompts,
} from './scenarios.ts'

async function load<T>(runtime: string, file: string): Promise<T> {
  return import(pathToFileURL(join(runtime, file)).href)
}

export async function runRuntimeLarkAttempt(params: {
  runtimePath: string
  artifactDir: string
  scenario: ScenarioId
  thinking: string
  dream?: boolean
  providers: Record<string, ProviderDefinition>
  sdkPath: string
  helpersPath: string
  channelName: 'lark' | 'feishu'
  memoryStorePath: string
  evidence: Evidence
  getPhase: () => number
  setPhase: (p: number) => void
}): Promise<void> {
  const {
    runtimePath,
    artifactDir,
    scenario,
    thinking,
    dream,
    providers,
    sdkPath,
    helpersPath,
    channelName,
    memoryStorePath,
    evidence,
    getPhase,
    setPhase,
  } = params

  const sdkMod = await load<typeof import('../../packages/vela/src/index.ts')>(
    runtimePath,
    sdkPath,
  )
  const runtimeHelpers = await load<Record<string, unknown>>(
    runtimePath,
    helpersPath,
  )
  const helpers = {
    fakeLark: runtimeHelpers[
      channelName === 'lark' ? 'fakeLark' : 'fakeFeishu'
    ] as typeof import('../../test/support/lark.ts')['fakeLark'],
    larkEvent: runtimeHelpers[
      channelName === 'lark' ? 'larkEvent' : 'feishuEvent'
    ] as typeof import('../../test/support/lark.ts')['larkEvent'],
    historyMessage:
      runtimeHelpers.historyMessage as typeof import('../../test/support/lark.ts')['historyMessage'],
  }

  const fake = helpers.fakeLark()
  if (scenario === 'G1') {
    fake.history.push(
      helpers.historyMessage(
        'meeting',
        'ou_bob',
        'The release meeting starts at 14:30 UTC.',
        '1000',
      ),
    )
  }
  if (scenario === 'G5') {
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

  const files = fixtures(scenario)
  const exitScenario = ['G6', 'G7', 'G8'].includes(scenario)
  const workspaceScenario = scenario === 'G10'
  const recallScenario = scenario === 'G7' || scenario === 'G8'
  const topicRoots =
    scenario === 'G6'
      ? ['g6_b', 'g6_a']
      : scenario === 'G8'
        ? ['g8_store', 'g8_recall']
        : ['g7_store', 'g7_recall']

  const dataDir = join(artifactDir, 'data')
  const workspace = join(
    dataDir,
    'channels',
    channelName,
    'oc_group',
    'workspace',
  )
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })

  if (recallScenario) {
    evidence.recallPaths = {
      workspace,
      artifactDir: resolve(artifactDir),
    }
    evidence.recallMemory = []
  }

  const runtime = sdkMod.createRuntime({
    agentDir: dataDir,
    providers,
    defaultModel: 'eval/deepseek-flash',
    defaultThinkingLevel: thinking as 'max',
    limits: { retryBaseMs: 500 },
    dreamEnabled: false,
    mcp: false,
    hostEnv: {},
  })

  const logicalBySessionId = new Map<string, string>()
  const sessionIdByTopicRoot = new Map<string, string>()
  const mapSessionId = (sid: string) => logicalBySessionId.get(sid) ?? sid
  const refreshTopicMappings = async () => {
    const bindings = await runtime.bindings.list({ channel: channelName })
    for (const rootId of topicRoots) {
      const binding = bindings.find(
        (b) => b.externalId === 'oc_group' && b.threadId === `thread_${rootId}`,
      )
      if (binding?.sessionId) {
        const logical = `${channelName}-oc_group-${rootId}`
        logicalBySessionId.set(binding.sessionId, logical)
        sessionIdByTopicRoot.set(rootId, binding.sessionId)
      }
    }
  }

  const calls = new Map<string, Call>()
  let channelStarted = false
  let channelError: unknown
  let burstDelivered = false
  let hubSessionId: string | undefined

  const unsub = runtime.events.subscribe((event) => {
    if (event.type === 'run_started') {
      channelStarted = true
      if (
        scenario === 'G9' &&
        !burstDelivered &&
        event.sessionId === hubSessionId
      ) {
        burstDelivered = true
        for (const [index, discussion] of burstDiscussion.entries()) {
          fake.deliver(
            helpers.larkEvent(
              {
                message_id: `burst_${index + 1}`,
                create_time: String(3100 + index),
                mentions: [],
                content: JSON.stringify({ text: discussion.text }),
              },
              discussion.sender,
            ),
          )
        }
      }
    }
    if (
      recallScenario &&
      event.type === 'message_committed' &&
      event.customType === 'memory' &&
      mapSessionId(event.sessionId) ===
        `${channelName}-oc_group-${topicRoots[1]}`
    ) {
      const content = event.message.content
      if (typeof content === 'string') evidence.recallMemory!.push(content)
    }
    if (event.type === 'tool_started') {
      const evalToolNameMap: Record<string, string> = {
        session_start: 'channel_start_topic',
        session_message: 'channel_message_topic',
        wait_for_input: 'channel_wait_for_input',
        skip_reply: 'channel_skip_reply',
        timers: 'channel_routines',
      }
      const rawArgs =
        event.input && typeof event.input === 'object'
          ? { ...(event.input as Record<string, unknown>) }
          : {}
      if (typeof rawArgs.path === 'string') {
        rawArgs.path = relative(workspace, resolve(workspace, rawArgs.path))
      }
      if (
        typeof rawArgs.target === 'string' &&
        logicalBySessionId.has(rawArgs.target)
      ) {
        rawArgs.target = logicalBySessionId.get(rawArgs.target)!
      }
      const call: Call = {
        name: evalToolNameMap[event.toolName] ?? event.toolName,
        args: rawArgs,
        phase: getPhase(),
        sessionId: mapSessionId(event.sessionId),
        success: false,
      }
      calls.set(event.toolCallId, call)
      evidence.calls.push(call)
    }
    if (event.type === 'tool_finished') {
      const call = calls.get(event.toolCallId)
      if (call) {
        call.success = !event.isError
        const mappedSid = call.sessionId
        if (
          (recallScenario &&
            (mappedSid === `${channelName}-oc_group-${topicRoots[1]}` ||
              call.name === 'memory')) ||
          (scenario === 'G6' && mappedSid?.endsWith('-g6_b'))
        ) {
          call.output = event.result
        }
      }
    }
    if (
      event.type === 'run_finished' &&
      event.status === 'failed' &&
      event.error
    ) {
      channelError = new Error(event.error)
    }
  })

  try {
    const project = await runtime.projects.create({
      name: 'oc_group',
      cwd: workspace,
      hubSessionId: true,
      defaultLocation: { environment: 'local', cwd: workspace },
    })
    hubSessionId = project.hubSessionId ?? undefined
    if (hubSessionId) {
      logicalBySessionId.set(hubSessionId, `${channelName}-oc_group`)
    }
    await runtime.bindings.upsert({
      channel: channelName,
      externalId: 'oc_group',
      threadId: null,
      kind: 'group',
      projectId: project.id,
      enabled: true,
    })

    const adapter = sdkMod.createLarkChannelAdapter({
      appId: 'eval-bot',
      owners: ['ou_alice'],
      chats: ['oc_group'],
      transport: fake.transport,
    })
    await runtime.registerChannel(adapter)

    const topicMessageScope = new Map<string, string>()

    if (exitScenario) {
      evidence.inputs = []
      for (const [index, text] of prompts(scenario).entries()) {
        setPhase(index)
        if (index === (scenario === 'G6' ? 1 : 0)) {
          for (const [path, content] of Object.entries(files)) {
            await mkdir(dirname(join(workspace, path)), { recursive: true })
            await Bun.write(join(workspace, path), content)
          }
        }
        channelStarted = false
        const topicRootId = topicRoots[index]!
        const triggerId = `trigger_${topicRootId}`
        topicMessageScope.set(triggerId, topicRootId)
        evidence.inputs.push({ topicRootId, text })
        fake.deliver(
          helpers.larkEvent({
            message_id: triggerId,
            root_id: topicRootId,
            thread_id: `thread_${topicRootId}`,
            create_time: String(3000 + index * 1000),
            content: JSON.stringify({ text: `@_user_1 ${text}` }),
          }),
        )
        while (!channelStarted && !channelError) await Bun.sleep(1)
        await runtime.waitForIdle()
        await refreshTopicMappings()
        if (channelError) throw channelError

        if (scenario === 'G8' && index === 0 && dream) {
          const storeSid = sessionIdByTopicRoot.get(topicRoots[0]!)
          if (storeSid) {
            await runtime.prompt(storeSid, { text: '/dream' })
            await runtime.waitForIdle()
          }
        }
        if (recallScenario && index === 0) {
          const { MemoryStore } = await load<
            typeof import('../../packages/vela/src/runtime/memory/index.ts')
          >(runtimePath, memoryStorePath)
          const projectStore = new MemoryStore(
            join(dataDir, 'memory', 'projects', project.id),
          )
          const globalStore = new MemoryStore(join(dataDir, 'memory'))
          const combined = [...projectStore.list(), ...globalStore.list()]
          evidence.memoryEntries = combined.map(({ name, content }) => ({
            name,
            content,
          }))
          await Bun.write(
            join(artifactDir, 'memory-after-topic-1.json'),
            JSON.stringify(evidence.memoryEntries, null, 2),
          )
        }
      }
      for (const item of fake.sent) {
        const mappedRoot = item.messageId
          ? topicMessageScope.get(item.messageId)
          : undefined
        evidence.deliveries.push({
          scope: mappedRoot ? 'topic' : 'group',
          ...(mappedRoot ? { topicRootId: mappedRoot } : {}),
          ...(item.messageId ? { messageId: item.messageId } : {}),
          text: item.text.replace(/<at\b[^>]*>.*?<\/at>\s*/g, ''),
        })
      }
      evidence.answers = evidence.deliveries.map((item) => item.text)
    } else {
      if (scenario === 'G11') {
        fake.deliver(
          helpers.larkEvent({
            message_id: 'discussion',
            create_time: '3000',
            mentions: [],
            content: JSON.stringify({ text: prompts(scenario)[0] }),
          }),
        )
        while (!channelStarted && !channelError) await Bun.sleep(1)
        await runtime.waitForIdle()
        if (channelError) throw channelError
        channelStarted = false
      }
      if (workspaceScenario) {
        for (const [path, content] of Object.entries(files)) {
          await mkdir(dirname(join(workspace, path)), { recursive: true })
          await Bun.write(join(workspace, path), content)
        }
      }
      const unmentioned = scenario === 'G3' || scenario === 'G10'
      fake.deliver(
        helpers.larkEvent({
          message_id: scenario === 'G11' ? 'follow_up' : 'trigger',
          create_time: scenario === 'G11' ? '4000' : '3000',
          mentions: unmentioned
            ? []
            : [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
          content: JSON.stringify({
            text: `${unmentioned ? '' : '@_user_1 '}${prompts(scenario)[scenario === 'G11' ? 1 : 0]}`,
          }),
          ...(['G4', 'G5'].includes(scenario)
            ? { root_id: 'root', thread_id: 'thread' }
            : {}),
        }),
      )
      while (!channelStarted && !channelError) await Bun.sleep(1)
      await runtime.waitForIdle()
      if (channelError) throw channelError
      if (workspaceScenario) {
        for (const path of Object.keys(files)) {
          evidence.files[path] = await Bun.file(join(workspace, path))
            .text()
            .catch(() => '')
        }
      }
      evidence.topics = fake.topics.map((topic) => topic.title)
      evidence.deliveries = fake.sent.map((item) => ({
        scope:
          scenario === 'G9' ||
          scenario === 'G11' ||
          (item.messageId === 'trigger' && !['G4', 'G5'].includes(scenario))
            ? 'group'
            : 'topic',
        ...(item.messageId ? { messageId: item.messageId } : {}),
        text: item.text.replace(/<at\b[^>]*>.*?<\/at>\s*/g, ''),
      }))
      evidence.answers = evidence.deliveries.map((item) => item.text)
    }

    for (const call of evidence.calls) {
      if (call.sessionId && logicalBySessionId.has(call.sessionId)) {
        call.sessionId = logicalBySessionId.get(call.sessionId)
      }
    }
  } finally {
    unsub()
    await runtime.dispose().catch(() => {})
  }
}
