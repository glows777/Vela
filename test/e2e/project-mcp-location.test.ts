import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
  tempDir,
} from '@glows777/vela/testing'
import {
  cliHostExtensionConfig,
  cliProjectExtensions,
} from '../../packages/vela/src/cli/project-extensions.ts'
import {
  loadCliExtensions,
  parseArgs,
} from '../../packages/vela/src/cli/setup.ts'
import { loadConfig } from '../../packages/vela/src/config/index.ts'

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

test('CLI project MCP assembly isolates same-named stdio servers and shares each scope until its last session closes', async () => {
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
      join(cwd!, '.vela/mcp.json'),
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
  const config = loadConfig({
    cwd: a,
    agentDir,
    trusted: true,
    env: {},
    builtins: ['mcp'],
  })
  const args = parseArgs(['serve'])
  const errors: string[] = []
  const model = createFauxModel({
    responses: Array.from({ length: 3 }, () => [
      fauxToolCall('mcp__local__echo', { text: 'hello' }),
      fauxText('done'),
    ]).flat(),
  })
  const vela = createVela({
    cwd: a,
    dataDir: join(dir.path, 'data'),
    model,
    sessionResources: {
      ...config.sessionResources!,
      workspaceModeAt: () => 'all',
      projectExtensions: cliProjectExtensions(config, args),
    },
    extensions: await loadCliExtensions(
      config,
      args,
      (error) => errors.push(error),
      true,
    ),
    extensionConfig: cliHostExtensionConfig(config, args),
  })
  try {
    const a1 = vela.session('a1'),
      bs = vela.session('b', { cwd: b }),
      a2 = vela.session('a2')
    await a1.prompt('echo hello')
    expect(existsSync(join(a, 'server.pid'))).toBe(true)
    const apid = Number(readFileSync(join(a, 'server.pid'), 'utf8'))
    expect(alive(apid)).toBe(true)
    await bs.prompt('echo hello')
    const bpid = Number(readFileSync(join(b, 'server.pid'), 'utf8'))
    expect(bpid).not.toBe(apid)
    expect(alive(bpid)).toBe(true)
    await a2.prompt('echo hello')
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
    expect(model.calls[4]!.system).toBe(model.calls[0]!.system)
    expect(model.calls[4]!.tools).toEqual(model.calls[0]!.tools)
    expect(errors).toEqual([])
    await a1.close()
    expect(alive(apid)).toBe(true)
    await bs.close()
    await stopped(bpid)
    expect(alive(apid)).toBe(true)
    await a2.close()
    await stopped(apid)
  } finally {
    await vela.dispose()
    for (const cwd of [a, b])
      if (existsSync(join(cwd, 'server.pid'))) {
        const pid = Number(readFileSync(join(cwd, 'server.pid'), 'utf8'))
        if (alive(pid)) process.kill(pid, 'SIGKILL')
      }
    dir.cleanup()
  }
}, 30000)
