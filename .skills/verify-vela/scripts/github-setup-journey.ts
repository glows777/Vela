/** Packed CLI acceptance. Run via vela-verify.sh exec (see journeys.md). No live GitHub calls. */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { packWorkspaces } from '../../../scripts/workspaces.ts'

const repo = resolve(import.meta.dir, '../../..')
const work = process.cwd()
const home = process.env.VELA_DIR!
assert(
  home && process.env.HOME && home.startsWith('/tmp/'),
  'Use the isolated verify-vela helper',
)
const evidence = join(work, 'github-evidence')
mkdirSync(evidence, { recursive: true })
const run = async (
  name: string,
  cmd: string[],
  env = process.env,
  cwd = work,
) => {
  const proc = Bun.spawn(cmd, {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  writeFileSync(
    join(evidence, `${name}.json`),
    JSON.stringify({ cmd, out, err, code }, null, 2),
  )
  return { out, err, code }
}
assert.equal(
  (await run('build', [process.execPath, 'run', 'build'], process.env, repo))
    .code,
  0,
)
const packed = await packWorkspaces(repo, join(work, 'release'))
// Same scoped registry contract as scripts/consumer-smoke.ts: unchanged release tarballs,
// one direct Vela dependency, and the normal registry for external dependencies.
const byName = new Map(packed.map((p) => [p.name, p]))
const byTar = new Map(packed.map((p) => [`/tar/${p.key}.tgz`, p]))
let registryURL = ''
const registry = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const archive = byTar.get(url.pathname)
    if (archive) return new Response(Bun.file(archive.tarball))
    const pkg = byName.get(decodeURIComponent(url.pathname.slice(1)))
    if (!pkg) return new Response('not found', { status: 404 })
    return Response.json({
      name: pkg.name,
      'dist-tags': { latest: pkg.version },
      versions: {
        [pkg.version]: {
          ...pkg.manifest,
          dist: {
            tarball: `${registryURL}/tar/${pkg.key}.tgz`,
            integrity: pkg.integrity,
          },
        },
      },
    })
  },
})
registryURL = `http://127.0.0.1:${registry.port}`
writeFileSync(join(work, '.npmrc'), `@glows777:registry=${registryURL}/\n`)
const umbrella = packed.find((p) => p.key === 'vela')!
writeFileSync(
  join(work, 'package.json'),
  JSON.stringify({
    private: true,
    type: 'module',
    dependencies: { [umbrella.name]: umbrella.version },
  }),
)
try {
  const installEnv = { ...process.env }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    const value = process.env[`VERIFY_INSTALL_${key}`]
    if (value) installEnv[key] = value
  }
  assert.equal(
    (await run('install', [process.execPath, 'install'], installEnv)).code,
    0,
  )
} finally {
  registry.stop(true)
}
// Prepare packaging independently while a feature implementation is still in progress.
if (process.argv.includes('--prepare-only')) {
  console.log('PASS fresh packed CLI installation; setup acceptance not run')
  process.exit(0)
}
const cli = [
  process.execPath,
  '--no-env-file',
  join(work, 'node_modules/@glows777/vela/dist/cli/main.js'),
]
const bin = join(work, 'bin')
mkdirSync(bin)
writeFileSync(
  join(bin, 'gh'),
  `#!/bin/sh\nexec '${process.execPath}' '${repo}/test/support/github-setup-gh.ts' "$@"\n`,
)
chmodSync(join(bin, 'gh'), 0o700)
const state = join(evidence, 'gh-state.json')
writeFileSync(state, JSON.stringify({ hooks: {}, calls: [] }))
const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  GH_SETUP_STATE: state,
}
const settingsPath = join(home, 'settings.json')
assert.equal(
  existsSync(settingsPath),
  false,
  'First setup requires empty user settings',
)
const args = [
  'setup',
  'github',
  'owner/repo',
  '--url',
  'https://fixture.example',
]
const first = await run('setup-first', [...cli, ...args], env)
assert.equal(first.code, 0)
assert.match(first.out + first.err, /owner\/repo: created webhook/)
assert((first.out + first.err).includes(settingsPath))
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
assert.equal(settings.extensionConfig.channel.eventReceiver.port, 8787)
writeFileSync(
  join(evidence, 'settings-first.json'),
  JSON.stringify(settings, null, 2),
  { mode: 0o600 },
)
const secret = settings.extensionConfig.channel.eventReceiver.github.secret
assert.match(secret, /^[a-f0-9]{64}$/)
assert.equal(statSync(settingsPath).mode & 0o777, 0o600)
assert.equal(existsSync(join(home, 'auth.json')), false)
const second = await run('setup-second', [...cli, ...args], env)
assert.equal(second.code, 0)
assert.match(second.out + second.err, /owner\/repo: updated webhook/)
assert.equal(
  JSON.parse(readFileSync(settingsPath, 'utf8')).extensionConfig.channel
    .eventReceiver.github.secret,
  secret,
)
assert(!(first.out + first.err + second.out + second.err).includes(secret))
const remote = JSON.parse(readFileSync(state, 'utf8'))
assert.equal(remote.hooks['owner/repo'].length, 1)
assert.equal(remote.hooks['owner/repo'][0].config.secret, secret)
assert(remote.calls.length > 0)
for (const call of remote.calls) {
  assert.equal(
    call.settings.extensionConfig.channel.eventReceiver.github.secret,
    secret,
  )
  assert(
    call.settings.extensionConfig.channel.eventReceiver.github.repositories.includes(
      'owner/repo',
    ),
  )
}
assert.equal(
  (await run('missing-input', [...cli, 'setup', 'github'], env)).code,
  2,
)
console.log(
  'PASS packed setup: empty user settings, default port 8787, paths, mode 0600, persistent secret, one hook after repeat, missing-input exit 2',
)

// Only after empty-user setup/repeat acceptance, select a fixture-local fixed port.
// Never rewrite a real user's configuration. Preserve the initial settings evidence.
writeFileSync(
  join(evidence, 'settings-second.json'),
  readFileSync(settingsPath),
  { mode: 0o600 },
)
const probe = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => new Response('probe'),
})
const port = probe.port
probe.stop(true)
settings.extensionConfig.channel.eventReceiver.port = port
writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
assert.equal(statSync(settingsPath).mode & 0o777, 0o600)
writeFileSync(
  join(evidence, 'settings-serve.json'),
  readFileSync(settingsPath),
  { mode: 0o600 },
)

const replyFile = join(evidence, 'replies.txt')
const extension = join(work, 'fixture-channel.ts')
writeFileSync(
  extension,
  `import { appendFileSync } from 'node:fs';
export default vela => { let handler; vela.registerChannel({ name: 'fixture', description: 'offline fixture',
start() { setTimeout(() => handler({ channelId: 'chat', senderId: 'human', senderName: 'Fixture', text: 'Subscribe' }), 0) },
stop() {}, onMessage(next) { handler = next }, async send(message) { appendFileSync(${JSON.stringify(replyFile)}, message.text + '\\n') } }); }`,
)
const scenario = join(work, 'scenario.json')
writeFileSync(
  scenario,
  JSON.stringify({
    responses: [
      {
        toolCalls: [
          {
            name: 'channel_subscriptions',
            input: {
              action: 'create',
              source: 'github',
              key: 'github:owner/repo#pr/1',
            },
          },
        ],
      },
      { text: 'Subscribed' },
      { text: 'Webhook delivered' },
    ],
  }),
)
const proc = Bun.spawn([...cli, 'serve', '--no-extensions', '-e', extension], {
  cwd: work,
  env: { ...env, VELA_MODEL: `faux:${scenario}` },
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe',
})
let stderr = ''
const reading = (async () => {
  for await (const chunk of proc.stderr)
    stderr += new TextDecoder().decode(chunk)
})()
const timeout = setTimeout(() => proc.kill('SIGKILL'), 30_000)
const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 20_000
  while (!check() && Date.now() < deadline) await Bun.sleep(20)
  assert(check(), stderr)
}
const url = `http://127.0.0.1:${port}/events/github`
try {
  await waitFor(
    () =>
      stderr.includes(url) &&
      existsSync(replyFile) &&
      readFileSync(replyFile, 'utf8').includes('Subscribed'),
  )
  const body = JSON.stringify({
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
  })
  const response = await fetch(url, {
    method: 'POST',
    body,
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'packed-fixture',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
  })
  assert.equal(response.status, 202)
  await waitFor(() =>
    readFileSync(replyFile, 'utf8').includes('Webhook delivered'),
  )
  assert(!stderr.includes(secret))
} finally {
  proc.kill('SIGTERM')
  await proc.exited
  clearTimeout(timeout)
  await reading
  writeFileSync(join(evidence, 'serve.stderr'), stderr)
  writeFileSync(
    join(evidence, 'serve.stdout'),
    await new Response(proc.stdout).text(),
  )
  writeFileSync(join(evidence, 'serve.exit'), String(proc.exitCode))
}
assert.equal(proc.exitCode, 0)
assert.equal(readFileSync(join(evidence, 'serve.stdout'), 'utf8'), '')
assert.equal(await fetch(url).catch(() => undefined), undefined)
console.log(
  'PASS packed serve: saved receiver settings, signed HTTP, subscribed reply, SIGTERM and closed port',
)
console.log(
  'LIMITS: gh API, channel transport and model are simulated; no live GitHub permissions, tunnel, delivery or model behavior verified.',
)
console.log(
  `Evidence: ${evidence}; copy it before helper cleanup. No credentials from the parent environment are used.`,
)
