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
import { background, fileSessionStorage } from '@glows777/vela-core'
import { fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { runServe } from '../../../packages/vela/src/cli/serve.ts'
import { fakeLark, larkEvent } from '../../support/lark.ts'

const [cwd, mode, scope] = process.argv.slice(2) as [string, string, string]
const restart = mode.startsWith('restart')
const report = (name: string, value: unknown) =>
  writeFileSync(join(cwd, name), JSON.stringify(value))
const fake = fakeLark()
if (mode === 'restart-accepted' || mode === 'restart-ledger') {
  const path = join(cwd, 'notice-ledger.json')
  const ledger: {
    attempts: { uuid?: string; text: string }[]
    deliveries: { uuid?: string; text: string }[]
  } = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : { attempts: [], deliveries: [] }
  const reply = fake.transport.reply.bind(fake.transport)
  fake.transport.reply = async (id, text, uuid) => {
    ledger.attempts.push({ uuid, text })
    if (!uuid || !ledger.deliveries.some((entry) => entry.uuid === uuid))
      ledger.deliveries.push({ uuid, text })
    report('notice-ledger.json', ledger)
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (mode === 'restart-accepted' && text.includes('RESTART NOTICE')) {
      report('notice-accepted.json', true)
      return new Promise<never>(() => {})
    }
    return reply(id, text, uuid)
  }
}

const command = `echo $$ > '${cwd}/shell.pid'; while [ ! -f '${cwd}/release' ]; do sleep 0.05; done; echo REAL BACKGROUND RESULT`
const storage = fileSessionStorage(join(cwd, '.vela-data/sessions'))
const append = storage.append.bind(storage)
let blockBackgroundWrite = false
storage.append = async (id, entries) => {
  if (blockBackgroundWrite) {
    report('save-gate.json', true)
    await new Promise<never>(() => {})
  }
  await append(id, entries)
}
const t = createTestVela({
  sessionStorage: storage,
  cwd,
  responses: restart
    ? [
        (request) => {
          report('recovery-request.json', request)
          return fauxText('RESTART NOTICE')
        },
        (request) => {
          report('second-recovery-request.json', request)
          return fauxText('RESTART NOTICE TWO')
        },
      ]
    : [
        (request) => {
          report('initial-system.json', request.system)
          return fauxToolCall('bash', { command, run_in_background: true })
        },
        ...(mode === 'multiple'
          ? [
              fauxToolCall('bash', {
                command: command.replace('shell.pid', 'shell-second.pid'),
                run_in_background: true,
              }),
            ]
          : []),
        ...(mode === 'stopped'
          ? [fauxToolCall('background_stop', { id: 'bg-1' })]
          : []),
        ...(mode === 'waiting-before-save'
          ? [
              fauxToolCall('channel_wait_for_input', {
                reason: 'Choose the deployment target',
              }),
            ]
          : []),
        fauxText('INITIAL ANSWER'),
        (request) => {
          report('normal-request.json', request)
          return fauxText('NORMAL RESULT')
        },
      ],
  extensions: [
    background(),
    lark({
      owners: ['ou_alice'],
      chats: ['oc_group'],
      transport: fake.transport,
    }),
    function boundary(api) {
      api.on('session_start', (_event, { session }) => {
        if (mode !== 'restart-after-save') return
        const save = session.save.bind(session)
        session.save = async (options) => {
          const marker = session
            .getEntries()
            .some(
              (entry) =>
                entry.type === 'custom' &&
                entry.customType === 'channel.input' &&
                !!(entry.data as { backgroundJobToken?: string })
                  ?.backgroundJobToken,
            )
          if (!marker) return save(options)
          if (mode === 'restart-after-save') await save(options)
          report('save-gate.json', true)
          await new Promise<never>(() => {})
        }
      })
    },
  ],
})
if (mode === 'restart-after-save')
  t.model.doStream = () => new Promise<never>(() => {})
await t.vela.ready()
const serving = runServe({
  vela: t.vela,
  write: (line) => appendFileSync(join(cwd, 'serve.log'), `${line}\n`),
})
while (!t.vela.runningChannels().length) await Bun.sleep(5)
const directory = () =>
  JSON.parse(readFileSync(join(cwd, '.vela-data/channels/index.json'), 'utf8'))
    .records as { state: string; outstandingJobs?: unknown[] }[]
if (!restart) {
  fake.deliver(
    larkEvent({
      message_id: 'original',
      ...(scope === 'topic' ? { root_id: 'root', thread_id: 'thread' } : {}),
      content: JSON.stringify({ text: 'Run a background command' }),
    }),
  )
  while (
    !fake.sent.some((message) => message.text.includes('INITIAL ANSWER')) ||
    !directory().every(
      (record) =>
        record.state === (mode === 'waiting-before-save' ? 'waiting' : 'done'),
    )
  )
    await Bun.sleep(10)
  if (mode !== 'stopped')
    while (!existsSync(join(cwd, 'shell.pid'))) await Bun.sleep(10)
  if (mode === 'multiple')
    while (!existsSync(join(cwd, 'shell-second.pid'))) await Bun.sleep(10)
  if (
    mode === 'normal' ||
    mode === 'before-save' ||
    mode === 'waiting-before-save'
  ) {
    if (mode === 'before-save' || mode === 'waiting-before-save') {
      report(
        'before-notice-transcript.json',
        readFileSync(
          join(cwd, '.vela-data/sessions/lark-oc_group-root/transcript.jsonl'),
          'utf8',
        ),
      )
      blockBackgroundWrite = true
    }
    writeFileSync(join(cwd, 'release'), '')
    if (mode === 'normal')
      while (
        !fake.sent.some((message) => message.text.includes('NORMAL RESULT')) ||
        directory().some((record) => record.outstandingJobs?.length)
      )
        await Bun.sleep(10)
  }
  report('ready.json', true)
} else {
  const deadline = Date.now() + 10000
  while (
    directory().some(
      (record) => record.outstandingJobs?.length || record.state === 'running',
    )
  ) {
    if (Date.now() > deadline)
      throw new Error(`Restart did not settle: ${JSON.stringify(directory())}`)
    await Bun.sleep(10)
  }
  await Bun.sleep(100)
  report('calls.json', t.model.calls)
  report('sent.json', fake.sent)
  process.kill(process.pid, 'SIGTERM')
}
process.exit(await serving)
