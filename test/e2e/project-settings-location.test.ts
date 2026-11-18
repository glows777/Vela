import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '@glows777/vela'
import { createFauxModel, fauxText, tempDir } from '@glows777/vela/testing'
import { loadConfig, type ThinkingLevel } from '@glows777/vela-core'

function project(cwd: string, label: string, thinking: ThinkingLevel) {
  mkdirSync(join(cwd, '.vela', 'declared-skills', label), { recursive: true })
  mkdirSync(join(cwd, '.vela', 'declared-prompts'), { recursive: true })
  writeFileSync(
    join(cwd, '.vela', 'declared-skills', label, 'SKILL.md'),
    `---\nname: ${label.toLowerCase()}\ndescription: ${label}_DECLARED_SKILL\n---\n${label} body`,
  )
  writeFileSync(
    join(cwd, '.vela', 'declared-prompts', 'project.md'),
    `${label}_DECLARED_PROMPT`,
  )
  writeFileSync(
    join(cwd, '.vela', 'settings.json'),
    JSON.stringify({
      defaultThinkingLevel: thinking,
      skills: ['./declared-skills'],
      prompts: ['./declared-prompts'],
    }),
  )
}
function setup(denied = false, explicit?: ThinkingLevel) {
  const dir = tempDir()
  const a = join(dir.path, 'A'),
    b = join(dir.path, 'B'),
    agentDir = join(dir.path, 'user')
  mkdirSync(agentDir)
  project(a, 'A', 'low')
  project(b, 'B', 'high')
  const config = loadConfig({ cwd: a, agentDir, trusted: true, env: {} })
  const model = createFauxModel({
    responses: Array.from({ length: 12 }, () => fauxText('done')),
  })
  const vela = createVela({
    cwd: a,
    dataDir: join(dir.path, 'data'),
    model,
    thinkingLevel: explicit,
    sessionResources: {
      ...config.sessionResources!,
      workspaceModeAt: (cwd) => (denied && cwd === b ? 'none' : 'all'),
    },
  })
  return { dir, a, b, agentDir, model, vela }
}

test('startup A opens B with B declared resources and thinking; A request prefix stays byte-identical', async () => {
  const t = setup()
  try {
    const a = t.vela.session('a')
    await a.prompt('/project')
    const first = t.model.calls[0]!
    expect(first.lastUserText).toBe('A_DECLARED_PROMPT')
    expect(first.system).toContain('A_DECLARED_SKILL')
    const b = t.vela.session('b', {
      location: { environment: 'local', cwd: t.b },
    })
    await b.prompt('/project')
    expect(t.model.calls[1]!.lastUserText).toBe('B_DECLARED_PROMPT')
    expect(t.model.calls[1]!.system).toContain('B_DECLARED_SKILL')
    expect(t.model.calls[1]!.system).not.toContain('A_DECLARED_SKILL')
    expect(b.thinkingLevel).toBe('high')
    await a.prompt('continue A')
    expect(t.model.calls[2]!.system).toBe(first.system)
    expect(JSON.stringify(t.model.calls[2]!.tools)).toBe(
      JSON.stringify(first.tools),
    )
    expect(a.thinkingLevel).toBe('low')
    expect(t.model.calls.map((call) => call.reasoning)).toEqual([
      'low',
      'high',
      'low',
    ])
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('denied B receives neither project A nor B settings/resources', async () => {
  const t = setup(true)
  try {
    const b = t.vela.session('denied', { cwd: t.b })
    await b.prompt('/project')
    expect(t.model.calls[0]!.lastUserText).toBe('/project')
    expect(t.model.calls[0]!.system).not.toContain('A_DECLARED_SKILL')
    expect(t.model.calls[0]!.system).not.toContain('B_DECLARED_SKILL')
    expect(b.thinkingLevel).toBe('medium')
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('project settings edit leaves an open session pinned and applies to a new session', async () => {
  const t = setup()
  try {
    const old = t.vela.session('old')
    await old.prompt('/project')
    const first = t.model.calls[0]!
    project(t.a, 'UPDATED', 'high')
    // Change the declared location, not an already-read template's contents alone.
    const settings = {
      defaultThinkingLevel: 'high',
      skills: ['./declared-skills/UPDATED'],
      prompts: ['./declared-prompts'],
    }
    writeFileSync(join(t.a, '.vela/settings.json'), JSON.stringify(settings))
    await old.prompt('/project')
    expect(t.model.calls[1]!.lastUserText).toBe('A_DECLARED_PROMPT')
    expect(t.model.calls[1]!.system).toBe(first.system)
    expect(old.thinkingLevel).toBe('low')
    const fresh = t.vela.session('fresh')
    await fresh.prompt('/project')
    expect(t.model.calls[2]!.lastUserText).toBe('UPDATED_DECLARED_PROMPT')
    expect(t.model.calls[2]!.system).toContain('UPDATED_DECLARED_SKILL')
    expect(t.model.calls[2]!.system).not.toContain('A_DECLARED_SKILL')
    expect(fresh.thinkingLevel).toBe('high')
    expect(t.model.calls.map((call) => call.reasoning)).toEqual([
      'low',
      'low',
      'high',
    ])
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
})

test('saved, manual and explicit thinking choices outrank the session project default on resume', async () => {
  const t = setup()
  try {
    const original = t.vela.session('saved', { cwd: t.b })
    original.setThinkingLevel('medium')
    await original.prompt('save the manual choice')
    await original.close()
    const resumed = t.vela.session('saved', { cwd: t.a })
    expect(await resumed.resume()).toBe(true)
    await resumed.prompt('/project')
    expect(resumed.cwd).toBe(t.b)
    expect(resumed.thinkingLevel).toBe('medium')
    expect(t.model.calls[1]!.lastUserText).toBe('B_DECLARED_PROMPT')
    resumed.setThinkingLevel('low')
    await resumed.prompt('manual choice now')
    expect(resumed.thinkingLevel).toBe('low')
    await resumed.close()
    const explicit = t.vela.session('saved', {
      cwd: t.a,
      thinkingLevel: 'high',
    })
    await explicit.resume()
    await explicit.prompt('explicit choice')
    expect(explicit.thinkingLevel).toBe('high')
    expect(t.model.calls.map((call) => call.reasoning)).toEqual([
      'medium',
      'medium',
      'low',
      'high',
    ])
  } finally {
    await t.vela.dispose()
    t.dir.cleanup()
  }
  const explicit = setup(false, 'medium')
  try {
    const b = explicit.vela.session('explicit-host', { cwd: explicit.b })
    await b.prompt('host explicit choice')
    expect(b.thinkingLevel).toBe('medium')
  } finally {
    await explicit.vela.dispose()
    explicit.dir.cleanup()
  }
})

test('real CLI launched from A resumes B and expands B declared prompt rather than A', async () => {
  const dir = tempDir()
  const a = join(dir.path, 'A'),
    b = join(dir.path, 'B'),
    home = join(dir.path, 'home')
  mkdirSync(home)
  project(a, 'A', 'low')
  project(b, 'B', 'high')
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({ dataDir: join(dir.path, 'data') }),
  )
  writeFileSync(
    join(home, 'trust.json'),
    JSON.stringify({ [a]: true, [b]: true }),
  )
  writeFileSync(
    join(home, 'scenario.json'),
    JSON.stringify({ responses: [{ text: 'done' }] }),
  )
  const run = async (cwd: string, message: string) => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL('../../packages/vela/src/cli/main.ts', import.meta.url)
          .pathname,
        '--session',
        'saved-b',
        '--mode',
        'json',
        message,
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          VELA_DIR: home,
          VELA_MODEL: `faux:${join(home, 'scenario.json')}`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toMatchObject({ code: 0 })
    return stdout
  }
  try {
    expect(await run(b, '/project')).toContain('B_DECLARED_PROMPT')
    const output = await run(a, '/project')
    expect(output).toContain('B_DECLARED_PROMPT')
    expect(output).not.toContain('A_DECLARED_PROMPT')
  } finally {
    dir.cleanup()
  }
}, 30000)
