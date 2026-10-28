import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { projectDataDir } from '../../packages/core/src/config/paths.ts'
import { tempDir } from '../support/vela.ts'

const ROOT = resolve(import.meta.dir, '../..')
const ENTRY = join(ROOT, 'packages/vela/src/cli/main.ts')

// `serve` runs until a signal stops it, so the tests spawn one process each and wait for stderr
setDefaultTimeout(30_000)

const dirs: { cleanup(): void }[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

/**
 * A channel that delivers one message once it starts and appends every reply to a file.
 * `start()` returning normally means "connected", so the gateway counts it as running.
 */
const serveChannel = (name: string, replyFile: string, text: string) => `
import { appendFileSync } from 'node:fs'
export default (vela) => {
  let handler
  vela.registerChannel({
    name: ${JSON.stringify(name)},
    description: 'test channel',
    start: () => {
      setTimeout(
        () =>
          handler?.({
            channelId: 'c1',
            senderId: 'u1',
            senderName: 'visitor',
            text: ${JSON.stringify(text)},
          }),
        0,
      )
    },
    stop: () => {},
    send: async (message) => {
      appendFileSync(${JSON.stringify(replyFile)}, message.text + '\\n')
    },
    onMessage: (next) => {
      handler = next
    },
  })
}
`

function spawnServe(
  args: string[],
  dir: string,
  home: string,
  env: Record<string, string> = {},
) {
  return Bun.spawn(['bun', ENTRY, ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      VELA_DIR: home,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
}

async function verifyWebhookServe(adapter: 'github' | 'generic') {
  const dir = tempDir('vela-serve-hooks-')
  const home = tempDir('vela-serve-hooks-home-')
  dirs.push(dir, home)
  const replies = join(dir.path, 'replies.txt')
  const extension = join(dir.path, 'channel.ts')
  await Bun.write(extension, serveChannel('fake', replies, 'Subscribe'))
  await Bun.write(
    join(home.path, 'settings.json'),
    JSON.stringify({
      extensionConfig: {
        channel: {
          eventReceiver: {
            port: 0,
            [adapter]:
              adapter === 'github'
                ? {
                    secret: '$WEBHOOK_FIXTURE_SECRET',
                    repositories: ['owner/repo'],
                  }
                : { secret: '$WEBHOOK_FIXTURE_SECRET', source: 'sentry' },
          },
        },
      },
    }),
  )
  await Bun.write(
    join(dir.path, 'reply.json'),
    JSON.stringify({
      responses: [
        {
          toolCalls: [
            {
              name: 'channel_subscriptions',
              input: {
                action: 'create',
                source: adapter === 'github' ? 'github' : 'sentry',
                key:
                  adapter === 'github'
                    ? 'github:owner/repo#pr/1'
                    : 'sentry:project',
              },
            },
          ],
        },
        { text: 'Subscribed' },
        { text: 'Webhook delivered' },
      ],
    }),
  )
  const proc = spawnServe(
    ['serve', '--no-extensions', '-e', extension],
    dir.path,
    home.path,
    { VELA_MODEL: 'faux:reply.json', WEBHOOK_FIXTURE_SECRET: 'fixture-only' },
  )
  let stderr = ''
  const reading = (async () => {
    for await (const chunk of proc.stderr)
      stderr += new TextDecoder().decode(chunk)
  })()
  const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000)
  let url: string | undefined
  try {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      url = stderr.match(
        /http:\/\/127\.0\.0\.1:\d+\/events\/(?:github|generic)/,
      )?.[0]
      if (
        url &&
        existsSync(replies) &&
        (await Bun.file(replies).text()).includes('Subscribed')
      )
        break
      await Bun.sleep(1)
    }
    expect(url).toBeDefined()
    const raw = JSON.stringify(
      adapter === 'generic'
        ? { key: 'sentry:project', summary: '!stop', final: true }
        : {
            action: 'closed',
            repository: { full_name: 'owner/repo' },
            pull_request: {
              number: 1,
              merged: true,
              title: 'Fixture',
              user: { login: 'author' },
              head: { sha: 'a'.repeat(40) },
              html_url: 'https://github.com/owner/repo/pull/1',
            },
          },
    )
    expect(
      (
        await fetch(url!, {
          method: 'POST',
          headers: {
            ...(adapter === 'github'
              ? { 'x-github-event': 'pull_request' }
              : {}),
            [adapter === 'github' ? 'x-github-delivery' : 'x-vela-delivery']:
              'serve-fixture',
            [adapter === 'github'
              ? 'x-hub-signature-256'
              : 'x-vela-signature-256']:
              `sha256=${createHmac('sha256', 'fixture-only').update(raw).digest('hex')}`,
          },
          body: raw,
        })
      ).status,
    ).toBe(202)
    while (
      !(await Bun.file(replies).text()).includes('Webhook delivered') &&
      Date.now() < deadline
    )
      await Bun.sleep(1)
    expect(await Bun.file(replies).text()).toContain('Webhook delivered')
    expect(stderr).not.toContain('fixture-only')
  } finally {
    proc.kill('SIGTERM')
    await proc.exited
    clearTimeout(timer)
    await reading
  }
  expect(proc.exitCode).toBe(0)
  expect(await new Response(proc.stdout).text()).toBe('')
  expect(await fetch(url!).catch(() => undefined)).toBeUndefined()
}

test.each(['github', 'generic'] as const)(
  'serve loads %s webhook settings, handles signed input and closes ingress on SIGTERM',
  verifyWebhookServe,
)

/** Starts the CLI and waits for it to exit; the caller asserts on the result */
async function runServe(
  args: string[],
  dir: string,
  home: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = spawnServe(args, dir, home)
  const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { stdout, stderr, code }
}

test('serve answers a channel message on stderr and stops cleanly on SIGTERM', async () => {
  const dir = tempDir('vela-serve-')
  dirs.push(dir)
  const home = tempDir('vela-serve-home-')
  dirs.push(home)
  const replyFile = join(dir.path, 'replies.txt')
  const extension = join(dir.path, 'channel.ts')
  await Bun.write(extension, serveChannel('fake', replyFile, 'ping'))
  await Bun.write(
    join(dir.path, 'reply.json'),
    JSON.stringify({ responses: [{ text: 'pong' }] }),
  )

  const proc = spawnServe(
    ['serve', '--no-extensions', '-e', extension],
    dir.path,
    home.path,
    { VELA_MODEL: 'faux:reply.json' },
  )
  let stderr = ''
  const decoder = new TextDecoder()
  const reading = (async () => {
    for await (const chunk of proc.stderr) stderr += decoder.decode(chunk)
  })()
  const deadline = Date.now() + 15_000
  while (
    !(stderr.includes('channel_reply') && existsSync(replyFile)) &&
    Date.now() < deadline
  )
    await Bun.sleep(20)

  proc.kill('SIGTERM')
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ])
  await reading

  // Nothing on stdout, and the channel's traffic is one timestamped line per event
  expect(code).toBe(0)
  expect(stdout).toBe('')
  expect(stderr).toMatch(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} channel_message fake visitor: ping$/m,
  )
  expect(stderr).toMatch(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} channel_reply fake → pong$/m,
  )
  expect(await Bun.file(replyFile).text()).toBe('pong\n')
  // The channel session was saved before the process exited
  const sessions = readdirSync(
    join(projectDataDir(home.path, dir.path), 'sessions'),
  ).filter((name) => name.endsWith('.jsonl'))
  expect(sessions).toHaveLength(1)
})

test('a stop signal during channel startup still disposes instead of dying', async () => {
  const dir = tempDir('vela-serve-')
  dirs.push(dir)
  const home = tempDir('vela-serve-home-')
  dirs.push(home)
  const connecting = join(dir.path, 'connecting')
  const stopped = join(dir.path, 'stopped')
  const extension = join(dir.path, 'slow-channel.ts')
  // A transport connect that takes a moment, like the Lark socket: the signal arrives while start() runs
  await Bun.write(
    extension,
    `import { appendFileSync } from 'node:fs'
export default (vela) => {
  vela.registerChannel({
    name: 'slow',
    description: 'slow to connect',
    start: async () => {
      appendFileSync(${JSON.stringify(connecting)}, 'connecting\\n')
      await Bun.sleep(400)
    },
    stop: () => appendFileSync(${JSON.stringify(stopped)}, 'stopped\\n'),
    send: async () => {},
    onMessage: () => {},
  })
}
`,
  )
  const proc = spawnServe(
    ['serve', '--no-extensions', '-e', extension],
    dir.path,
    home.path,
  )
  const reading = (async () => {
    for await (const _ of proc.stderr) {
      // Drain, so a full pipe never blocks the child
    }
  })()
  const deadline = Date.now() + 15_000
  while (!existsSync(connecting) && Date.now() < deadline) await Bun.sleep(10)
  expect(existsSync(connecting)).toBe(true)
  proc.kill('SIGTERM')
  const code = await proc.exited
  await reading
  // Exit 0 means dispose() ran: the channel was stopped, not killed by the default signal handler
  expect(code).toBe(0)
  expect(existsSync(stopped)).toBe(true)
})

test('serve exits 1 instead of idling when no channel started', async () => {
  const dir = tempDir('vela-serve-')
  dirs.push(dir)
  const home = tempDir('vela-serve-home-')
  dirs.push(home)
  await Bun.write(
    join(dir.path, 'reply.json'),
    JSON.stringify({ responses: [{ text: 'unused' }] }),
  )
  const result = await runServe(
    ['serve', '--no-extensions'],
    dir.path,
    home.path,
  )
  expect(result.code).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('[serve] no channel started')
})

test('serve rejects the flags of a single-session run', async () => {
  const dir = tempDir('vela-serve-')
  dirs.push(dir)
  const home = tempDir('vela-serve-home-')
  dirs.push(home)
  for (const args of [
    ['serve', '-p', 'hi'],
    ['serve', '--mode', 'json'],
    ['serve', '-t', 'read_file'],
    ['serve', 'a prompt'],
  ]) {
    const result = await runServe(args, dir.path, home.path)
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Usage: vela')
  }
})
