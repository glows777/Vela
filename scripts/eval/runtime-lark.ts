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
  signal?: AbortSignal
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
    signal,
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

  // Track exact message/topic destinations from transport calls so deliveries never rely on guesses.
  const messageThreadScope = new Map<string, string>()
  const threadToRoot = new Map<string, string>()
  for (const rootId of topicRoots) {
    messageThreadScope.set(`trigger_${rootId}`, rootId)
    threadToRoot.set(`thread_${rootId}`, rootId)
  }
  if (['G4', 'G5'].includes(scenario)) {
    messageThreadScope.set('trigger', 'root')
    threadToRoot.set('thread', 'root')
  }

  const trackedDeliveries: Evidence['deliveries'] = []
  const trackedTopics: string[] = []
  const baseTransport = fake.transport
  const trackedTransport: typeof fake.transport = {
    ...baseTransport,
    send: async (chatId, text, uuid) => {
      const receipt = await baseTransport.send(chatId, text, uuid)
      if (receipt) {
        trackedDeliveries.push({
          scope: 'group',
          ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
          text: text.replace(/<at\b[^>]*>.*?<\/at>\s*/g, ''),
        })
      }
      return receipt
    },
    reply: async (messageId, text, uuid) => {
      const receipt = await baseTransport.reply(messageId, text, uuid)
      const rootId = messageThreadScope.get(messageId)
      trackedDeliveries.push({
        scope: rootId ? 'topic' : 'group',
        ...(rootId ? { topicRootId: rootId } : {}),
        messageId,
        text: text.replace(/<at\b[^>]*>.*?<\/at>\s*/g, ''),
      })
      return receipt
    },
    startTopic: async (messageId, title, uuid) => {
      const isExistingTopicAnchor =
        Array.from(threadToRoot.values()).includes(messageId) ||
        messageThreadScope.has(messageId)
      const opened = await baseTransport.startTopic(messageId, title, uuid)
      const knownRoot =
        messageThreadScope.get(messageId) ?? opened.rootId ?? messageId
      if (!isExistingTopicAnchor) {
        trackedTopics.push(title)
        if (opened.threadId) {
          threadToRoot.set(opened.threadId, knownRoot)
        }
      } else {
        trackedDeliveries.push({
          scope: 'topic',
          topicRootId: knownRoot,
          messageId: opened.messageId,
          text: title.replace(/<at\b[^>]*>.*?<\/at>\s*/g, ''),
        })
      }
      return opened
    },
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
  const rawMemoryBySessionId = new Map<string, string[]>()
  const calls = new Map<string, Call>()
  let channelStarted = false
  let channelError: unknown
  let burstDelivered = false
  let hubSessionId: string | undefined

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
      event.customType === 'memory'
    ) {
      const content = event.message.content
      if (typeof content === 'string') {
        const existing = rawMemoryBySessionId.get(event.sessionId) ?? []
        existing.push(content)
        rawMemoryBySessionId.set(event.sessionId, existing)
      }
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
      const call: Call = {
        name: evalToolNameMap[event.toolName] ?? event.toolName,
        args: rawArgs,
        phase: getPhase(),
        sessionId: event.sessionId,
        success: false,
      }
      calls.set(event.toolCallId, call)
      evidence.calls.push(call)
    }
    if (event.type === 'tool_finished') {
      const call = calls.get(event.toolCallId)
      if (call) {
        call.success = !event.isError
        call.output = event.result
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

  const onAbort = () => {
    void (async () => {
      const sessions = await runtime.sessions.list().catch(() => [])
      await Promise.all(
        sessions.map((s) =>
          runtime.stop(s.id, 'Scenario deadline exceeded').catch(() => {}),
        ),
      )
      await runtime.dispose().catch(() => {})
    })()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

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
    if (recallScenario) {
      evidence.recallPaths = {
        workspace: join(dataDir, 'projects', project.id, 'memory'),
        artifactDir: resolve(artifactDir),
      }
      evidence.recallMemory = []
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
      transport: trackedTransport,
    })
    await runtime.registerChannel(adapter)

    const waitStartedAndIdle = async () => {
      while (!channelStarted && !channelError && !signal?.aborted) {
        await Bun.sleep(1)
      }
      signal?.throwIfAborted?.()
      await runtime.waitForIdle()
      signal?.throwIfAborted?.()
      if (channelError) throw channelError
    }

    if (exitScenario) {
      evidence.inputs = []
      for (const [index, text] of prompts(scenario).entries()) {
        signal?.throwIfAborted?.()
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
        await waitStartedAndIdle()
        await refreshTopicMappings()

        if (scenario === 'G8' && index === 0 && dream) {
          const storeSid = sessionIdByTopicRoot.get(topicRoots[0]!)
          if (storeSid) {
            const cmdRes = await runtime.sessions.runCommand(storeSid, '/dream')
            if (!cmdRes.handled) {
              throw new Error('G8 /dream command was not handled')
            }
            await runtime.waitForIdle()
            signal?.throwIfAborted?.()
          }
        }
        if (recallScenario && index === 0) {
          const { MemoryStore, resolveMemoryDirs } = await load<
            typeof import('../../packages/vela/src/runtime/memory/index.ts')
          >(runtimePath, memoryStorePath)
          const dirs = resolveMemoryDirs(dataDir, project.id)
          const projectStore = new MemoryStore(dirs.localDir)
          const globalStore = new MemoryStore(dirs.globalDir)
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
    } else {
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(workspace, path)), { recursive: true })
        await Bun.write(join(workspace, path), content)
      }
      if (scenario === 'G11') {
        fake.deliver(
          helpers.larkEvent({
            message_id: 'discussion',
            create_time: '3000',
            mentions: [],
            content: JSON.stringify({ text: prompts(scenario)[0] }),
          }),
        )
        await waitStartedAndIdle()
        channelStarted = false
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
      await waitStartedAndIdle()
      for (const path of Object.keys(files)) {
        evidence.files[path] = await Bun.file(join(workspace, path))
          .text()
          .catch(() => '')
      }
    }

    await refreshTopicMappings()
    if (recallScenario) {
      const recallSid = sessionIdByTopicRoot.get(topicRoots[1]!)
      if (recallSid) {
        evidence.recallMemory = [...(rawMemoryBySessionId.get(recallSid) ?? [])]
      }
    }
    for (const call of evidence.calls) {
      const rawSid = call.sessionId
      if (rawSid && logicalBySessionId.has(rawSid)) {
        call.sessionId = logicalBySessionId.get(rawSid)
      }
      if (
        typeof call.args.target === 'string' &&
        logicalBySessionId.has(call.args.target)
      ) {
        call.args.target = logicalBySessionId.get(call.args.target)!
      }
      const keepOutput =
        (recallScenario &&
          (call.sessionId === `${channelName}-oc_group-${topicRoots[1]}` ||
            call.name === 'memory')) ||
        (scenario === 'G6' && call.sessionId?.endsWith('-g6_b'))
      if (!keepOutput) {
        delete call.output
      }
    }
    evidence.topics = trackedTopics
    evidence.deliveries = trackedDeliveries
    evidence.answers = trackedDeliveries.map((item) => item.text)
  } finally {
    signal?.removeEventListener('abort', onAbort)
    unsub()
    await runtime.dispose().catch(() => {})
  }
}
