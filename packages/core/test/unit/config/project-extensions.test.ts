import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadProjectExtensionEntries } from '../../../src/config/project-extensions.ts'
import { loadConfig } from '../../../src/config/settings.ts'
import { tempDir } from '../../../src/testing/index.ts'

function write(path: string) {
  writeFileSync(
    path,
    'throw new Error("descriptor discovery must never import code")',
  )
}

test('startup public extension view stays ordered while host provenance excludes project code and builtin overrides', () => {
  const dir = tempDir()
  try {
    const user = join(dir.path, 'user'),
      cwd = join(dir.path, 'A'),
      project = join(cwd, '.vela')
    for (const base of [user, project])
      mkdirSync(join(base, 'extensions'), { recursive: true })
    write(join(user, 'extensions', 'user-discovered.ts'))
    write(join(user, 'user-listed.ts'))
    write(join(project, 'extensions', 'project-discovered.ts'))
    write(join(project, 'project-listed.ts'))
    writeFileSync(
      join(user, 'settings.json'),
      JSON.stringify({
        extensions: ['-builtin:memory', './user-listed.ts'],
        extensionConfig: { plugin: { value: 'user' } },
      }),
    )
    writeFileSync(
      join(project, 'settings.json'),
      JSON.stringify({
        extensions: ['+builtin:memory', './project-listed.ts'],
        extensionConfig: { plugin: { value: 'project' } },
      }),
    )
    const config = loadConfig({
      cwd,
      agentDir: user,
      trusted: true,
      builtins: ['memory', 'mcp'],
      defaultOffBuiltins: ['mcp'],
    })
    expect(config.extensions.map((e) => e.name)).toEqual([
      'memory',
      'user-discovered',
      'project-discovered',
      'user-listed',
      'project-listed',
    ])
    expect(config.sessionResources!.hostExtensions!.map((e) => e.name)).toEqual(
      ['user-discovered', 'user-listed'],
    )
    expect(config.sessionResources!.extensionBuiltins).toEqual({
      names: ['memory', 'mcp'],
      defaultOff: ['mcp'],
    })
    expect(config.userExtensionConfig.plugin).toEqual({ value: 'user' })
    expect(config.extensionConfig.plugin).toEqual({ value: 'project' })
    const scoped = loadProjectExtensionEntries(
      { id: 'node:local', cwd },
      {
        trusted: true,
        agentDir: user,
        settings: {
          extensions: ['+builtin:memory', join(project, 'project-listed.ts')],
        },
      },
    )
    expect(scoped.entries.map((e) => e.name)).toEqual([
      'project-discovered',
      'project-listed',
    ])
    expect(scoped.diagnostics).toEqual([])
  } finally {
    dir.cleanup()
  }
})

test('denied and remote locations never discover or import local project code; remote reports skip', () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir.path, '.vela/extensions'), { recursive: true })
    write(join(dir.path, '.vela/extensions', 'must-not-load.ts'))
    const options = {
      trusted: false,
      settings: { extensions: ['/missing-explicit-file.ts'] },
    }
    expect(
      loadProjectExtensionEntries({ id: 'node:local', cwd: dir.path }, options),
    ).toEqual({ entries: [], diagnostics: [] })
    const remote = loadProjectExtensionEntries(
      { id: 'test:remote', cwd: dir.path },
      { ...options, trusted: true },
    )
    expect(remote.entries).toEqual([])
    expect(remote.diagnostics.join(' ')).toContain('cannot execute on the host')
    expect(remote.diagnostics.join(' ')).toContain('test:remote')
    expect(() =>
      loadProjectExtensionEntries(
        { id: 'node:local', cwd: dir.path },
        { ...options, trusted: true },
      ),
    ).toThrow('Extension path does not exist')
    expect(
      loadProjectExtensionEntries(
        { id: 'node:local', cwd: dir.path },
        { trusted: true, agentDir: join(dir.path, '.vela'), settings: {} },
      ).entries,
    ).toEqual([])
  } finally {
    dir.cleanup()
  }
})
