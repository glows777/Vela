import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRuntime } from '@glows777/vela'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
  tempDir,
} from '@glows777/vela/testing'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function stopped(pid: number) {
  for (let n = 0; n < 200 && alive(pid); n++) await Bun.sleep(10)
  expect(alive(pid)).toBe(false)
}

test('createRuntime project MCP assembly isolates same-named stdio servers and stops on dispose', async () => {
  const dir = tempDir(),
    a = join(dir.path, 'A'),
    b = join(dir.path, 'B'),
    agentDir = join(dir.path, 'user')
  mkdirSync(agentDir)
  const server = new URL('../fixtures/mcp-echo-server.ts', import.meta.url)
    .pathname
  for (const [cwd, prefix] of [
    [a, 'A:'],
    [b, 'B:'],
  ]) {
    mkdirSync(join(cwd!, '.vela'), { recursive: true })
    writeFileSync(
      join(cwd!, '.vela/config.json'),
      JSON.stringify({
        mcpServers: {
          local: {
            command: process.execPath,
            args: [server],
            env: { ECHO_PREFIX: prefix, PID_FILE: join(cwd!, 'server.pid') },
            exposure: 'direct',
          },
        },
      }),
    )
  }
  const model = createFauxModel({
    responses: Array.from({ length: 3 }, () => [
      fauxToolCall('mcp__local__echo', { text: 'hello' }),
      fauxText('done'),
    ]).flat(),
  })
  const runtime = createRuntime({
    agentDir,
    defaultModel: model,
    hostEnv: {},
  })
  try {
    await runtime.ready()
    await runtime.trust.approve(a, true)
    await runtime.trust.approve(b, true)
    const a1 = await runtime.sessions.create({
      location: { environment: 'local', cwd: a },
    })
    const bs = await runtime.sessions.create({
      location: { environment: 'local', cwd: b },
    })
    const a2 = await runtime.sessions.create({
      location: { environment: 'local', cwd: a },
    })

    await runtime.prompt(a1.id, { text: 'echo hello' })
    await runtime.waitForIdle(a1.id)
    expect(existsSync(join(a, 'server.pid'))).toBe(true)
    const apid = Number(readFileSync(join(a, 'server.pid'), 'utf8'))
    expect(alive(apid)).toBe(true)

    await runtime.prompt(bs.id, { text: 'echo hello' })
    await runtime.waitForIdle(bs.id)
    const bpid = Number(readFileSync(join(b, 'server.pid'), 'utf8'))
    expect(bpid).not.toBe(apid)
    expect(alive(bpid)).toBe(true)

    await runtime.prompt(a2.id, { text: 'echo hello' })
    await runtime.waitForIdle(a2.id)
    expect(Number(readFileSync(join(a, 'server.pid'), 'utf8'))).toBe(apid)

    expect(
      model.calls[1]!.toolResults.map((r) => r.output).join(' '),
    ).toContain('A:hello')
    expect(
      model.calls[3]!.toolResults.map((r) => r.output).join(' '),
    ).toContain('B:hello')
    expect(
      model.calls[5]!.toolResults.map((r) => r.output).join(' '),
    ).toContain('A:hello')
    expect(model.calls[4]!.tools).toEqual(model.calls[0]!.tools)

    await runtime.dispose()
    await stopped(apid)
    await stopped(bpid)
  } finally {
    await runtime.dispose()
    for (const cwd of [a, b])
      if (existsSync(join(cwd, 'server.pid'))) {
        const pid = Number(readFileSync(join(cwd, 'server.pid'), 'utf8'))
        if (alive(pid)) process.kill(pid, 'SIGKILL')
      }
    dir.cleanup()
  }
}, 30000)
