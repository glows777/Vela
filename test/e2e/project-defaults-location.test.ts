import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela, type VelaOptions } from '@glows777/vela'
import { createFauxModel, fauxText, tempDir } from '@glows777/vela/testing'
import {
  loadConfig,
  type ProviderDefinition,
} from '../../packages/vela/src/driver/index.ts'

function setup() {
  const dir = tempDir()
  const a = join(dir.path, 'A'),
    b = join(dir.path, 'B'),
    agentDir = join(dir.path, 'user')
  mkdirSync(agentDir)
  const writeSettings = (cwd: string, values: object) => {
    mkdirSync(join(cwd, '.vela'), { recursive: true })
    writeFileSync(join(cwd, '.vela/settings.json'), JSON.stringify(values))
  }
  writeSettings(a, {
    defaultModel: 'fake/a',
    defaultThinkingLevel: 'low',
    limits: { maxRetries: 1 },
    autoCompaction: true,
  })
  writeSettings(b, {
    defaultModel: 'fake/b',
    defaultThinkingLevel: 'high',
    limits: { maxRetries: 4, maxInputTokens: 8000 },
    autoCompaction: false,
  })
  const models = Object.fromEntries(
    ['a', 'b', 'manual', 'explicit'].map((id) => [
      id,
      createFauxModel({
        modelId: id,
        responses: Array.from({ length: 20 }, () => fauxText(id)),
      }),
    ]),
  )
  const provider: ProviderDefinition = {
    models: Object.keys(models).map((id) => ({ id, contextWindow: 100_000 })),
    createModel: (id) => models[id]!,
  }
  const hosts: ReturnType<typeof createVela>[] = []
  const host = (options: Partial<VelaOptions> = {}) => {
    const config = loadConfig({ cwd: a, agentDir, trusted: true })
    const vela = createVela({
      cwd: a,
      dataDir: join(dir.path, 'data'),
      providers: { fake: provider },
      sessionResources: {
        ...config.sessionResources!,
        workspaceModeAt: () => 'all',
      },
      ...options,
    })
    hosts.push(vela)
    return vela
  }
  return {
    a,
    b,
    dir,
    models,
    host,
    writeSettings,
    cleanup: async () => {
      for (const vela of hosts) await vela.dispose()
      dir.cleanup()
    },
  }
}

test('project defaults route actual A/B requests and preserve project limits after a manual model switch', async () => {
  const t = setup()
  try {
    const vela = t.host()
    const a = vela.session('a'),
      b = vela.session('b', { cwd: t.b })
    await a.prompt('from A')
    await b.prompt('from B')
    expect(t.models.a!.calls[0]!.lastUserText).toBe('from A')
    expect(t.models.b!.calls[0]!.lastUserText).toBe('from B')
    expect(a.thinkingLevel).toBe('low')
    expect(b.thinkingLevel).toBe('high')
    expect(a.limits.maxRetries).toBe(1)
    expect(b.limits.maxRetries).toBe(4)
    expect(b.limits.maxInputTokens).toBe(8000)
    expect(a.autoCompaction).toBe(true)
    expect(b.autoCompaction).toBe(false)
    b.setModel('fake/manual')
    await b.prompt('manual B')
    expect(t.models.manual!.calls[0]!.lastUserText).toBe('manual B')
    expect(b.limits.maxRetries).toBe(4)
    expect(b.limits.maxInputTokens).toBe(8000)
    expect(b.autoCompaction).toBe(false)
  } finally {
    await t.cleanup()
  }
})

test('manual and explicit session selections beat project defaults before first preparation', async () => {
  const t = setup()
  try {
    const vela = t.host()
    const manual = vela.session('manual', { cwd: t.b })
    manual.setModel('fake/manual')
    manual.setThinkingLevel('off')
    manual.autoCompaction = true
    await manual.prompt('manual before prepare')
    expect(t.models.manual!.calls[0]!.lastUserText).toBe(
      'manual before prepare',
    )
    expect(manual.thinkingLevel).toBe('off')
    expect(manual.autoCompaction).toBe(true)
    const explicit = vela.session('explicit', {
      cwd: t.b,
      model: 'fake/explicit',
      thinkingLevel: 'medium',
      autoCompaction: true,
    })
    await explicit.prompt('explicit session')
    expect(t.models.explicit!.calls[0]!.lastUserText).toBe('explicit session')
    expect(explicit.thinkingLevel).toBe('medium')
    expect(explicit.autoCompaction).toBe(true)
    expect(t.models.b!.calls).toHaveLength(0)
  } finally {
    await t.cleanup()
  }
})

test('explicit host settings override project defaults, while saved model and thinking remain selections on resume', async () => {
  const t = setup()
  try {
    const first = t.host({
      model: 'fake/explicit',
      thinkingLevel: 'medium',
      limits: { maxRetries: 7 },
      autoCompaction: true,
    })
    const session = first.session('saved', { cwd: t.b })
    await session.prompt('host explicit')
    expect(t.models.explicit!.calls[0]!.lastUserText).toBe('host explicit')
    expect(session.thinkingLevel).toBe('medium')
    expect(session.limits.maxRetries).toBe(7)
    expect(session.limits.maxInputTokens).toBe(8000)
    expect(session.autoCompaction).toBe(true)
    session.setModel('fake/manual')
    session.setThinkingLevel('off')
    await session.prompt('save choice')
    await first.dispose()
    const second = t.host()
    const resumed = second.session('saved')
    expect(await resumed.resume()).toBe(true)
    await resumed.prompt('after resume')
    expect(resumed.cwd).toBe(t.b)
    expect(resumed.modelInfo.ref).toBe('fake/manual')
    expect(resumed.thinkingLevel).toBe('off')
    expect(t.models.manual!.calls.at(-1)!.lastUserText).toBe('after resume')
    expect(t.models.b!.calls).toHaveLength(0)
    await second.dispose()
    const overridden = t
      .host()
      .session('saved', { model: 'fake/explicit', thinkingLevel: 'low' })
    expect(await overridden.resume()).toBe(true)
    await overridden.prompt('explicit resume selection')
    expect(overridden.modelInfo.ref).toBe('fake/explicit')
    expect(overridden.thinkingLevel).toBe('low')
    expect(t.models.explicit!.calls.at(-1)!.lastUserText).toBe(
      'explicit resume selection',
    )
  } finally {
    await t.cleanup()
  }
})

test('setDefaults affects only sessions created afterwards, not prepared or pending sessions', async () => {
  const t = setup()
  try {
    const vela = t.host()
    const prepared = vela.session('prepared', { cwd: t.b })
    const pending = vela.session('pending', { cwd: t.b })
    await prepared.prompt('before defaults')
    vela.setDefaults('fake/explicit', 'off')
    const fresh = vela.session('fresh', { cwd: t.b })
    await prepared.prompt('old prepared')
    await pending.prompt('old pending')
    await fresh.prompt('new defaults')
    expect(t.models.b!.calls.map((call) => call.lastUserText)).toEqual([
      'before defaults',
      'old prepared',
      'old pending',
    ])
    expect(t.models.explicit!.calls.map((call) => call.lastUserText)).toEqual([
      'new defaults',
    ])
    expect(prepared.thinkingLevel).toBe('high')
    expect(pending.thinkingLevel).toBe('high')
    expect(fresh.thinkingLevel).toBe('off')
  } finally {
    await t.cleanup()
  }
})

test('local project shellPath selects the real A/B shell wrapper for SDK bash', async () => {
  const t = setup()
  try {
    const marker = join(t.dir.path, 'shells.log')
    for (const [cwd, label] of [
      [t.a, 'A'],
      [t.b, 'B'],
    ] as const) {
      const wrapper = join(cwd, 'shell-wrapper')
      writeFileSync(
        wrapper,
        `#!/bin/sh\nprintf '%s\\n' '${label}' >> '${marker}'\nexec /bin/bash "$@"\n`,
      )
      chmodSync(wrapper, 0o755)
      t.writeSettings(cwd, {
        defaultModel: `fake/${label.toLowerCase()}`,
        shellPath: wrapper,
      })
    }
    const vela = t.host()
    const a = vela.session('shell-a'),
      b = vela.session('shell-b', { cwd: t.b })
    const resultA = await a.executeBash('pwd')
    const resultB = await b.executeBash('pwd')
    expect(resultA.output.trim()).toBe(t.a)
    expect(resultB.output.trim()).toBe(t.b)
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['A', 'B'])
  } finally {
    await t.cleanup()
  }
})
