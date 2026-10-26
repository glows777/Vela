import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVela } from '../../src/index.ts'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
  tempDir,
} from '../../src/testing/index.ts'

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
    const search = { tools: ['+list_directory', '+grep', '+find'] }
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
        fauxToolCall('read_file', { path: 'same.txt' }),
        fauxToolCall('write_file', { path: 'result.txt', content: name }),
        fauxToolCall('edit_file', {
          path: 'result.txt',
          edits: [{ oldText: name, newText: `${name}!` }],
        }),
        fauxToolCall('list_directory', { path: '.' }),
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
      expect(model.calls[0]!.system).toContain('host-skill')
      expect(model.calls[0]!.system).not.toContain('local-skill')
      expect(model.calls[1]!.toolResults[0]!.output).toBe(name)
      expect(model.calls[4]!.toolResults.at(-1)!.output).toContain('result.txt')
      expect(model.calls[5]!.toolResults.at(-1)!.output).toContain(name)
      expect(model.calls[6]!.toolResults.at(-1)!.output).toContain('result.txt')
      expect(model.calls[7]!.toolResults.at(-1)!.output).toContain(`${name}!`)
      expect(readFileSync(join(path, 'result.txt'), 'utf8')).toBe(`${name}!`)
      expect((await session.executeBash('cat same.txt')).output).toBe(name)
      expect(
        JSON.parse(
          readFileSync(
            join(vela.dataDir, 'sessions', `${session.id}.jsonl`),
            'utf8',
          ).split('\n')[0]!,
        ),
      ).toMatchObject({ cwd: path })
    }
    expect(vela.cwd).toBe(host)
    expect(vela.dataDir).toBe(join(host, '.data'))
    expect(await sa.exportJsonl('export.jsonl')).toBe(
      join(host, 'export.jsonl'),
    )
    expect(await sb.exportHtml('export.html')).toBe(join(host, 'export.html'))
    modelA.push(fauxText('template'))
    await sa.prompt('/hello check')
    expect(modelA.calls.at(-1)!.lastUserText).toBe('Host template check')
    const cloned = (await sa.clone({ sessionId: 'clone' })).session!
    expect((await cloned.executeBash('cat same.txt')).output).toBe('ALPHA')
    await sa.close()
    const resumed = vela.session('a', { cwd: '../a' })
    expect(await resumed.resume()).toBe(true)
    expect((await resumed.executeBash('cat same.txt')).output).toBe('ALPHA')
    await resumed.close()
    const defaultCwd = vela.session('a')
    expect(await defaultCwd.resume()).toBe(true)
    expect((await defaultCwd.executeBash('cat same.txt')).output).toBe('HOST')
    modelA.push(fauxText('default'))
    await defaultCwd.prompt('Which instructions apply?')
    expect(modelA.calls.at(-1)!.system).toContain('Pinned host instructions')
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
