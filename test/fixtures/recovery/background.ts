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
import { openDatabase } from '../../../packages/vela/src/db/sqlite.ts'
import { background } from '../../../packages/vela/src/driver/index.ts'
import { lark } from '../../../packages/vela/src/lark/index.ts'
import {
  fauxText,
  fauxToolCall,
} from '../../../packages/vela/src/testing/core/index.ts'
import { fakeLark, larkEvent } from '../../support/lark.ts'
import { runServe } from './serve-helper.ts'

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
let blockBackgroundWrite = false
const db = openDatabase({ path: join(cwd, '.vela-data/vela.db') })
const t = createTestVela({
  db,
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
        const prompt = session.prompt.bind(session)
        session.prompt = async (input, options) => {
          if (blockBackgroundWrite) {
            report('save-gate.json', true)
            await new Promise<never>(() => {})
          }
          return prompt(input, options)
        }
        const save = session.save.bind(session)
        session.save = async () => {
          if (blockBackgroundWrite) {
            report('save-gate.json', true)
            await new Promise<never>(() => {})
          }
          if (mode !== 'restart-after-save') return save()
          const marker = session
            .getEntries()
            .some(
              (entry) =>
                entry.type === 'custom' &&
                entry.customType === 'channel.input' &&
                !!(entry.data as { backgroundJobToken?: string })
                  ?.backgroundJobToken,
            )
          if (!marker) return save()
          await save()
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
      const savedRows = db
        .all<{ id: string; kind: string; content_json: string }>(
          'SELECT id, kind, content_json FROM vela_messages WHERE session_id = ? ORDER BY seq',
          'lark-oc_group-root',
        )
        .map((row) => {
          const parsed = JSON.parse(row.content_json) as {
            customType?: string
            data?: unknown
          }
          return {
            id: row.id,
            kind: row.kind,
            custom_type:
              row.kind === 'custom' ? (parsed.customType ?? null) : null,
            data_json:
              row.kind === 'custom'
                ? JSON.stringify(parsed.data ?? null)
                : null,
          }
        })
      report('before-notice-transcript.json', JSON.stringify(savedRows))
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
