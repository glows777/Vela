import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
  tempDir,
} from '@glows777/vela/testing'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import { createVela } from '../support/compat-vela.ts'

test('SDK sessions use independent cwd for tools and context, preserving application resources and lifecycle', async () => {
  const dir = tempDir()
  const host = join(dir.path, 'host')
  const a = join(dir.path, 'a')
  const b = join(dir.path, 'b')
  for (const [path, name] of [
    [host, 'HOST'],
    [a, 'ALPHA'],
    [b, 'BETA'],
  ] as const) {
    mkdirSync(path)
    writeFileSync(join(path, 'same.txt'), name)
    writeFileSync(join(path, 'AGENTS.md'), `Instructions for ${name}`)
  }
  for (const [path, name] of [
    [host, 'host-skill'],
    [a, 'local-skill'],
  ] as const) {
    const skill = join(path, '.skills', name)
    mkdirSync(skill, { recursive: true })
    writeFileSync(
      join(skill, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Fixture skill\n---\nFixture`,
    )
  }
  mkdirSync(join(host, '.vela', 'prompts'), { recursive: true })
  writeFileSync(join(host, '.vela', 'prompts', 'hello.md'), 'Host template $1')
  mkdirSync(join(a, '.vela', 'prompts'), { recursive: true })
  writeFileSync(join(a, '.vela', 'prompts', 'hello.md'), 'Alpha template $1')
  const modelA = createFauxModel({ responses: [] })
  const modelB = createFauxModel({ responses: [] })
  const vela = createVela({
    cwd: host,
    dataDir: '.data',
    model: modelA,
    contextFiles: [
      { path: join(host, 'AGENTS.md'), content: 'Pinned host instructions' },
    ],
  })
  try {
    const search = { tools: ['+ls', '+grep', '+find'] }
    const sa = vela.session('a', { cwd: '../a', model: modelA, ...search })
    const sb = vela.session('b', { cwd: b, model: modelB, ...search })
    expect(sa.cwd).toBe(a)
    expect(sb.cwd).toBe(b)
    expect(vela.session('a', { cwd: b })).toBe(sa)
    for (const [session, model, name, path] of [
      [sa, modelA, 'ALPHA', a],
      [sb, modelB, 'BETA', b],
    ] as const) {
      model.push(
        fauxToolCall('read', { path: 'same.txt' }),
        fauxToolCall('write', { path: 'result.txt', content: name }),
        fauxToolCall('edit', {
          path: 'result.txt',
          edits: [{ oldText: name, newText: `${name}!` }],
        }),
        fauxToolCall('ls', { path: '.' }),
        fauxToolCall('grep', { pattern: name, path: '.' }),
        fauxToolCall('find', { pattern: 'result.txt', path: '.' }),
        fauxToolCall('bash', { command: 'cat result.txt' }),
        fauxText('done'),
      )
      await session.prompt(
        'Read, write, edit, list, search and run a command in this workspace',
      )
      expect(model.calls[0]!.system).toContain(path)
      expect(model.calls[0]!.system).toContain(`Instructions for ${name}`)
      expect(model.calls[0]!.system).not.toContain('Pinned host instructions')
      expect(model.calls[0]!.system).not.toContain('host-skill')
      if (name === 'ALPHA')
        expect(model.calls[0]!.system).toContain('local-skill')
      else expect(model.calls[0]!.system).not.toContain('local-skill')
      expect(model.calls[1]!.toolResults[0]!.output).toBe(name)
      expect(model.calls[4]!.toolResults.at(-1)!.output).toContain('result.txt')
      expect(model.calls[5]!.toolResults.at(-1)!.output).toContain(name)
      expect(model.calls[6]!.toolResults.at(-1)!.output).toContain('result.txt')
      expect(model.calls[7]!.toolResults.at(-1)!.output).toContain(`${name}!`)
      expect(readFileSync(join(path, 'result.txt'), 'utf8')).toBe(`${name}!`)
      expect((await session.executeBash('cat same.txt')).output).toBe(name)
      const db = openDatabase({
        path: join(vela.dataDir, 'vela.db'),
        readonly: true,
      })
      try {
        const row = db.get<{ location_json: string | null }>(
          'SELECT location_json FROM sessions WHERE id = ?',
          session.id,
        )
        expect(JSON.parse(row!.location_json!)).toMatchObject({ cwd: path })
      } finally {
        db.close()
      }
    }
    expect(vela.cwd).toBe(host)
    expect(vela.dataDir).toBe(join(host, '.data'))
    expect(await sa.exportJsonl('export.jsonl')).toBe(
      join(host, 'export.jsonl'),
    )
    expect(await sb.exportHtml('export.html')).toBe(join(host, 'export.html'))
    modelA.push(fauxText('template'))
    await sa.prompt('/hello check')
    expect(modelA.calls.at(-1)!.lastUserText).toBe('Alpha template check')
    const cloned = (await sa.clone({ sessionId: 'clone' })).session!
    expect((await cloned.executeBash('cat same.txt')).output).toBe('ALPHA')
    await sa.close()
    const resumed = vela.session('a', { cwd: '../a' })
    expect(await resumed.resume()).toBe(true)
    expect((await resumed.executeBash('cat same.txt')).output).toBe('ALPHA')
    await resumed.close()
    const defaultCwd = vela.session('a')
    expect(await defaultCwd.resume()).toBe(true)
    expect((await defaultCwd.executeBash('cat same.txt')).output).toBe('ALPHA')
    modelA.push(fauxText('default'))
    await defaultCwd.prompt('Which instructions apply?')
    expect(modelA.calls.at(-1)!.system).toContain('Instructions for ALPHA')
    const disabled = createVela({
      cwd: host,
      contextFiles: false,
      model: modelA,
    })
    try {
      modelA.push(fauxText('no context'))
      await disabled.session('disabled', { cwd: a }).prompt('Hello')
      expect(modelA.calls.at(-1)!.system).toContain(a)
      expect(modelA.calls.at(-1)!.system).not.toContain(
        'Instructions for ALPHA',
      )
    } finally {
      await disabled.dispose()
    }
  } finally {
    await vela.dispose()
    dir.cleanup()
  }
})
