import { expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { freeLocalPort, until } from '../support/local.ts'
import { tempDir } from '../support/vela.ts'

const ENTRY = resolve(import.meta.dir, '../../packages/vela/src/cli/main.ts')

async function fixture() {
  const cwd = tempDir('vela-local-config-')
  const home = tempDir('vela-local-config-home-')
  const port = await freeLocalPort()
  await Bun.write(
    join(home.path, 'settings.json'),
    JSON.stringify({
      extensionConfig: { local: { enabled: true, token: '$USER_TOKEN', port } },
    }),
  )
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home.path,
    VELA_DIR: home.path,
    VELA_OFFLINE: '1',
    VELA_MODEL: `faux:${resolve(import.meta.dir, '../fixtures/scenarios/hello.json')}`,
    USER_TOKEN: 'user-only-secret',
  }
  return {
    cwd,
    home,
    port,
    env,
    cleanup: () => {
      cwd.cleanup()
      home.cleanup()
    },
  }
}

test('RPC remains responsive without opening the configured Local listener', async () => {
  const f = await fixture()
  const proc = Bun.spawn(['bun', ENTRY, '--mode', 'rpc'], {
    cwd: f.cwd.path,
    env: f.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let stdout = ''
  const reading = (async () => {
    for await (const chunk of proc.stdout)
      stdout += new TextDecoder().decode(chunk)
  })()
  const stderr = new Response(proc.stderr).text()
  const timer = setTimeout(() => proc.kill('SIGKILL'), 15000)
  try {
    proc.stdin.write(`${JSON.stringify({ id: 'ready', type: 'get_state' })}\n`)
    proc.stdin.flush()
    await until(() => stdout.includes('"id":"ready"'), 'RPC ready')
    expect(
      await fetch(`http://127.0.0.1:${f.port}/v1/info`).catch(() => undefined),
    ).toBeUndefined()
    proc.stdin.end()
    expect(await proc.exited).toBe(0)
    expect(await stderr).not.toContain('user-only-secret')
  } finally {
    proc.kill('SIGTERM')
    await proc.exited
    await reading
    clearTimeout(timer)
    f.cleanup()
  }
}, 20000)

test.each([
  { args: ['-p', 'hello'] },
  { args: ['--mode', 'json', 'hello'] },
  { args: ['--list-models'] },
])(
  'ordinary CLI entry ignores invalid Local settings: %s',
  async ({ args }) => {
    const f = await fixture()
    await Bun.write(
      join(f.home.path, 'settings.json'),
      JSON.stringify({ extensionConfig: { local: { enabled: true } } }),
    )
    const proc = Bun.spawn(['bun', ENTRY, ...args], {
      cwd: f.cwd.path,
      env: f.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => proc.kill('SIGKILL'), 15000)
    try {
      const [code, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
        new Response(proc.stdout).text(),
      ])
      expect(code).toBe(0)
      expect(stderr).not.toContain('local.token')
    } finally {
      proc.kill()
      await proc.exited
      clearTimeout(timer)
      f.cleanup()
    }
  },
  20000,
)

test('trusted project cannot replace user Local port, token or enablement', async () => {
  const f = await fixture()
  const projectPort = await freeLocalPort()
  await Bun.write(
    join(f.cwd.path, '.vela/settings.json'),
    JSON.stringify({
      extensionConfig: {
        local: { enabled: false, token: 'project-secret', port: projectPort },
      },
    }),
  )
  const proc = Bun.spawn(['bun', ENTRY, 'serve', '--approve'], {
    cwd: f.cwd.path,
    env: f.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = new Response(proc.stderr).text()
  const stdout = new Response(proc.stdout).text()
  const timer = setTimeout(() => proc.kill('SIGKILL'), 15000)
  const url = `http://127.0.0.1:${f.port}/v1/info`
  try {
    await until(async () => {
      try {
        return (await fetch(url)).status === 401
      } catch {
        return false
      }
    }, 'user listener')
    expect(
      (
        await fetch(url, {
          headers: { Authorization: 'Bearer user-only-secret' },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(url, {
          headers: { Authorization: 'Bearer project-secret' },
        })
      ).status,
    ).toBe(401)
    expect(
      await fetch(`http://127.0.0.1:${projectPort}/v1/info`).catch(
        () => undefined,
      ),
    ).toBeUndefined()
    proc.kill('SIGTERM')
    expect(await proc.exited).toBe(0)
    expect(await stdout).toBe('')
    expect(await stderr).not.toContain('user-only-secret')
    expect(await fetch(url).catch(() => undefined)).toBeUndefined()
  } finally {
    proc.kill('SIGTERM')
    await proc.exited
    clearTimeout(timer)
    f.cleanup()
  }
}, 20000)
