import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import { createFauxModel, fauxText, tempDir } from '@glows777/vela/testing'
import { extensionCommands } from '../../packages/vela/src/cli/commands/extensions.ts'
import { runRpcMode } from '../../packages/vela/src/cli/rpc-mode.ts'
import { loadConfig } from '../../packages/vela/src/driver/index.ts'
import { local } from '../../packages/vela/src/legacy-channels/index.ts'
import { startTui, stopTuis } from '../support/terminal.ts'

function setup() {
  const dir = tempDir('vela-project-frontends-')
  const agentDir = join(dir.path, 'user')
  mkdirSync(agentDir)
  const projects = { alpha: join(dir.path, 'A'), beta: join(dir.path, 'B') }
  for (const [name, cwd] of Object.entries(projects)) {
    mkdirSync(join(cwd, '.vela'), { recursive: true })
    writeFileSync(
      join(cwd, '.vela/config.json'),
      JSON.stringify({ extensions: [`./${name}.ts`] }),
    )
    writeFileSync(
      join(cwd, `.vela/${name}.ts`),
      `export default function ${name}(api) {
        api.registerCommand('${name}-only', {description: '${name} project command', handler: (_args, ctx) => ctx.notify('${name} command ran')})
      }`,
    )
  }
  const config = loadConfig({
    cwd: projects.alpha,
    agentDir,
    trusted: true,
    env: {},
  })
  const model = createFauxModel({ responses: [] })
  const vela = createVela({
    cwd: projects.alpha,
    dataDir: join(dir.path, 'data'),
    sessionResources: {
      ...config.sessionResources!,
      workspaceModeAt: () => 'all',
    },
    model,
    extensions: [local({})],
  })
  return { dir, vela, model, projects }
}

test('/extensions prepares and lists only the active project, preserving host channel metadata', async () => {
  const t = setup()
  try {
    await t.vela.ready()
    const a = t.vela.session('A', { cwd: t.projects.alpha })
    const b = t.vela.session('B', { cwd: t.projects.beta })
    for (const [session, own, other] of [
      [a, 'alpha', 'beta'],
      [b, 'beta', 'alpha'],
      [a, 'alpha', 'beta'],
    ] as const) {
      const lines: string[] = []
      const ctx = {
        vela: t.vela,
        session,
        print: (line: string) => lines.push(line),
      }
      expect(extensionCommands[0]!('/unrelated', ctx)).toBe(false)
      await extensionCommands[0]!('/extensions', ctx)
      expect(lines.join('\n')).toContain(`Commands: /${own}-only`)
      expect(lines.join('\n')).not.toContain(`/${other}-only`)
      const loaded = t.vela.extensions(session.id)
      expect(loaded.find((entry) => entry.name === 'local')?.channels).toEqual([
        'local',
      ])
      expect(loaded.find((entry) => entry.name === own)?.channels).toEqual([])
    }
    expect(
      t.vela
        .sessions()
        .map((session) => session.id)
        .sort(),
    ).toEqual(['A', 'B'])
    expect(t.model.calls).toHaveLength(0)
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('TUI resumed project header, completion and slash command use the active session extensions', async () => {
  const t = setup()
  try {
    await t.vela.ready()
    await t.vela.session('A', { cwd: t.projects.alpha }).resources()
    const b = t.vela.session('B', { cwd: t.projects.beta })
    t.model.push(fauxText('Saved project B'))
    await b.prompt('Save the B session')
    await b.save()
    await b.close()
    const tui = await startTui(t.vela, { sessionId: 'B', resume: true })
    await tui.started
    expect(tui.screen()).toContain('beta')
    expect(tui.screen()).not.toContain('alpha')
    tui.terminal.type('/beta-')
    await tui.until('beta project command')
    // Clear the completion input before issuing the full command.
    tui.terminal.press('\x03')
    tui.submit('/beta-only')
    await tui.until('beta command ran')
    tui.submit('/extensions')
    await tui.until('Commands: /beta-only')
    expect(tui.screen()).not.toContain('/alpha-only')
    expect(t.model.calls).toHaveLength(1)
  } finally {
    await stopTuis()
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('RPC switches project command discovery and handles project commands without a model turn', async () => {
  const t = setup()
  try {
    await t.vela.ready()
    const b = t.vela.session('B', { cwd: t.projects.beta })
    t.model.push(fauxText('Saved project B'))
    await b.prompt('Save the B session')
    await b.save()
    await b.close()
    const output: Array<{
      id?: string
      type: string
      success?: boolean
      data?: { commands?: { name: string }[]; disposition?: string }
    }> = []
    const pending = new Map<string, () => void>()
    const commands = [
      { id: 'a', type: 'get_commands' },
      { id: 'switch', type: 'switch_session', sessionId: 'B' },
      { id: 'b', type: 'get_commands' },
      { id: 'run', type: 'prompt', message: '/beta-only' },
    ]
    await runRpcMode({
      vela: t.vela,
      sessionId: 'A',
      resume: false,
      newSessionId: () => 'unused',
      input: (async function* () {
        for (const command of commands) {
          const response = new Promise<void>((resolve) =>
            pending.set(command.id, resolve),
          )
          yield new TextEncoder().encode(`${JSON.stringify(command)}\n`)
          await response
        }
      })(),
      write: async (line) => {
        const record = JSON.parse(line)
        output.push(record)
        if (record.type === 'response') pending.get(record.id)?.()
      },
    })
    for (const [id, own, other] of [
      ['a', 'alpha-only', 'beta-only'],
      ['b', 'beta-only', 'alpha-only'],
    ] as const) {
      const response = output.find((item) => item.id === id)!
      expect(response.success).toBe(true)
      const names = response.data!.commands!.map((command) => command.name)
      expect(names).toContain(own)
      expect(names).not.toContain(other)
    }
    expect(output.find((item) => item.id === 'run')?.data?.disposition).toBe(
      'handled',
    )
    expect(t.model.calls).toHaveLength(1)
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
})
