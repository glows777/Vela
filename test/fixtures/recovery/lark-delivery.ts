import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createTestVela } from '@glows777/vela/testing'
import { lark } from '../../../packages/vela/src/lark/index.ts'
import {
  fauxText,
  fauxToolCall,
} from '../../../packages/vela/src/testing/core/index.ts'
import { fakeLark, larkEvent } from '../../support/lark.ts'

const [cwd, rawMode] = process.argv.slice(2) as [string, string]
const direct = rawMode.startsWith('dm-')
const multi = rawMode.startsWith('multi-')
const mode = rawMode.replace(/^(dm-|multi-)/, '')
const ledgerPath = join(cwd, 'remote-ledger.json')
interface Ledger {
  attempts: { uuid?: string; text: string }[]
  deliveries: { uuid?: string; text: string }[]
}
const ledger: Ledger = existsSync(ledgerPath)
  ? JSON.parse(readFileSync(ledgerPath, 'utf8'))
  : { attempts: [], deliveries: [] }
function durable(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value))
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
const fake = fakeLark()
const send = async (method: string, text: string, uuid?: string) => {
  if (mode === 'before-send' && text.includes('FINAL ANSWER')) {
    durable(join(cwd, 'kill-ready'), true)
    return new Promise<never>(() => {})
  }
  appendFileSync(join(cwd, 'methods.txt'), `${method}\n`)
  ledger.attempts.push({ uuid, text })
  if (!uuid || !ledger.deliveries.some((item) => item.uuid === uuid))
    ledger.deliveries.push({ uuid, text })
  durable(ledgerPath, ledger)
  if (mode === 'transient' && text.includes('FINAL ANSWER'))
    throw new Error('temporary transport failure')
  if (
    (mode === 'accepted' && text.includes('FINAL ANSWER')) ||
    (mode === 'tool' && text === 'TOPIC TITLE')
  ) {
    durable(join(cwd, 'kill-ready'), true)
    return new Promise<never>(() => {})
  }
  return { messageId: 'remote-message', createTime: '1000' }
}
fake.transport.reply = (_id, text, uuid) => send('reply', text, uuid)
fake.transport.send = (_id, text, uuid) => send('create', text, uuid)
fake.transport.startTopic = async (_id, title, uuid) => ({
  ...(await send('startTopic', title, uuid)),
  rootId: 'new-root',
  threadId: 'new-thread',
})
const logs: string[] = []
const log = (message: string) => {
  logs.push(message)
  appendFileSync(join(cwd, 'logs.txt'), `${message}\n`)
}
const starting = ['accepted', 'confirmed', 'tool', 'before-send'].includes(mode)
const t = createTestVela({
  cwd,
  responses:
    mode === 'tool'
      ? [
          fauxToolCall('bash', { command: 'echo FINISHED EARLIER STEP' }),
          fauxToolCall('channel_start_topic', {
            title: 'TOPIC TITLE',
            brief: 'Perform the task',
          }),
        ]
      : mode === 'tool-restart'
        ? [
            (request) => {
              durable(join(cwd, 'tool-recovered-request.json'), request)
              return fauxText('TOOL RECOVERED')
            },
          ]
        : starting
          ? [
              ...(multi ? [fauxText('ALICE INITIAL')] : []),
              fauxText('FINAL ANSWER', { reasoning: 'PRIVATE THOUGHT' }),
            ]
          : [],
  logger: { debug: () => {}, info: log, warn: log, error: log },
  extensions: [
    lark({
      owners: ['ou_alice'],
      chats: ['oc_group'],
      transport: fake.transport,
    }),
  ],
})
if (mode === 'confirmed')
  t.vela.subscribe((event) => {
    if (event.type === 'channel_reply' && event.text.includes('FINAL ANSWER')) {
      // sendAnswer already saved confirmed; directory.finish has not run yet.
      durable(join(cwd, 'kill-ready'), true)
      process.kill(process.pid, 'SIGSTOP')
    }
  })
const keepAlive = setInterval(() => {}, 1000)
try {
  await t.vela.ready()
  if (mode === 'transient-save') {
    const index = JSON.parse(
      readFileSync(join(t.vela.dataDir, 'channels/index.json'), 'utf8'),
    )
    const session = t.vela.session(index.records[0].activeSessionId)
    const save = session.save.bind(session)
    session.save = async () => {
      session.save = save
      throw new Error('temporary save failure')
    }
  }
  await t.vela.startChannels()
  if (starting) {
    if (multi) {
      fake.deliver(
        larkEvent(
          {
            message_id: 'alice-trigger',
            root_id: 'root',
            thread_id: 'thread',
            content: '{"text":"Alice creates this topic"}',
          },
          'ou_alice',
        ),
      )
      const index = join(t.vela.dataDir, 'channels/index.json')
      while (
        !existsSync(index) ||
        !ledger.attempts.some((attempt) =>
          attempt.text.includes('ALICE INITIAL'),
        ) ||
        JSON.parse(readFileSync(index, 'utf8')).records[0].state !== 'done'
      )
        await Bun.sleep(10)
    }
    fake.deliver(
      larkEvent(
        {
          message_id: 'trigger',
          ...(direct
            ? { chat_type: 'p2p' as const }
            : mode === 'tool'
              ? {}
              : { root_id: 'root', thread_id: 'thread' }),
          content: '{"text":"Answer the request"}',
        },
        multi ? 'ou_bob' : 'ou_alice',
      ),
    )
    await new Promise(() => {})
  } else {
    const index = join(t.vela.dataDir, 'channels/index.json')
    const until = Date.now() + 10000
    while (true) {
      const records = JSON.parse(readFileSync(index, 'utf8')).records as {
        state: string
      }[]
      if (
        records.every((record) => record.state === 'done') ||
        logs.some(
          (line) =>
            line.includes('window expired') ||
            line.includes('temporary transport failure') ||
            line.includes('temporary save failure'),
        )
      )
        break
      if (Date.now() > until)
        throw new Error(
          `Delivery recovery did not settle: ${JSON.stringify({ logs, attempts: ledger.attempts })}`,
        )
      await Bun.sleep(10)
    }
    // Let the existing feedback path finish its diagnostic if expiry was refused.
    await Bun.sleep(100)
    durable(join(cwd, 'recovery.json'), { calls: t.model.calls.length, logs })
  }
} finally {
  clearInterval(keepAlive)
  await t.cleanup({ keepDir: true })
}
