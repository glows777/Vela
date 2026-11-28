import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRuntime, type RuntimeEvent } from '@glows777/vela'
import { createFauxModel, fauxText, tempDir } from '@glows777/vela/testing'
import { extensionCommands } from '../../packages/vela/src/cli/commands/extensions.ts'
import { loadConfig } from '../../packages/vela/src/driver/index.ts'
import { createVela } from '../support/compat-vela.ts'
import { legacyVelaAsRuntime } from '../support/legacy-vela-runtime.ts'
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
  })
  return { dir, vela, model, projects }
}

test('/extensions prepares and lists only the active project', async () => {
  const t = setup()
  try {
    await t.vela.ready()
    const { runtime, clientFor } = legacyVelaAsRuntime(t.vela)
    const a = t.vela.session('A', { cwd: t.projects.alpha })
    const b = t.vela.session('B', { cwd: t.projects.beta })
    for (const [session, own, other] of [
      [a, 'alpha', 'beta'],
      [b, 'beta', 'alpha'],
      [a, 'alpha', 'beta'],
    ] as const) {
      const lines: string[] = []
      const ctx = {
        runtime,
        session: clientFor(session),
        print: (line: string) => lines.push(line),
      }
      expect(extensionCommands[0]!('/unrelated', ctx)).toBe(false)
      await extensionCommands[0]!('/extensions', ctx)
      expect(lines.join('\n')).toContain(`Commands: /${own}-only`)
      expect(lines.join('\n')).not.toContain(`/${other}-only`)
      const loaded = await runtime.sessions.inspect(session.id)
      expect(
        loaded.extensions.find((entry) => entry.name === own)?.commands,
      ).toEqual([`${own}-only`])
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

test('TUI resumed project lists, completes and runs the active session extensions', async () => {
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
    tui.terminal.type('/beta-')
    await tui.until('beta project command')
    // Clear the completion input before issuing the full command.
    tui.terminal.press('\x03')
    tui.submit('/beta-only')
    await tui.until('beta command ran')
    tui.submit('/extensions')
    await tui.until('   beta\n     Commands: /beta-only')
    // The resumed session lists the project's own extension and nothing from the other project.
    const listing = tui.screen().slice(tui.screen().indexOf('[extensions]'))
    expect(listing).toContain('   beta\n     Commands: /beta-only')
    expect(listing).not.toContain('alpha')
    expect(t.model.calls).toHaveLength(1)
  } finally {
    await stopTuis()
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('createRuntime switches project command discovery and handles project commands without a model turn', async () => {
  const dir = tempDir('vela-project-runtime-')
  const agentDir = join(dir.path, 'user')
  mkdirSync(agentDir, { recursive: true })
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
  const model = createFauxModel({ responses: [] })
  const runtime = createRuntime({
    agentDir,
    hostEnv: {},
    defaultModel: model,
    trustOverride: () => true,
  })
  const events: RuntimeEvent[] = []
  const unsub = runtime.events.subscribe((ev) => events.push(ev))
  try {
    await runtime.ready()
    const pAlpha = await runtime.projects.create({
      name: 'alpha',
      cwd: projects.alpha,
    })
    const pBeta = await runtime.projects.create({
      name: 'beta',
      cwd: projects.beta,
    })
    await runtime.sessions.create({ id: 'A', projectId: pAlpha.id })
    await runtime.sessions.create({ id: 'B', projectId: pBeta.id })

    for (const [id, own, other] of [
      ['A', 'alpha-only', 'beta-only'],
      ['B', 'beta-only', 'alpha-only'],
    ] as const) {
      const inspected = await runtime.sessions.inspect(id)
      const names = inspected.commands.map((command) => command.name)
      expect(names).toContain(own)
      expect(names).not.toContain(other)
    }

    const res = await runtime.sessions.runCommand('B', '/beta-only')
    expect(res.handled).toBe(true)
    expect(
      events.some(
        (ev) => ev.type === 'notify' && ev.message === 'beta command ran',
      ),
    ).toBe(true)
    expect(model.calls).toHaveLength(0)
  } finally {
    unsub()
    await runtime.dispose()
    dir.cleanup()
  }
})
