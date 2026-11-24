import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectTrustRequired } from '../../../src/driver/diagnostics.ts'
import { tempDir } from '../../../src/testing/core/index.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
test('core config leaves MCP to its descriptor and trusts only declared project resources', async () => {
  const core = await import('../../../src/driver/index.ts')
  const { mcpConfig } = await import('../../../src/mcp/index.ts')
  const dir = tempDir('vela-config-contract-')
  cleanups.push(dir.cleanup)
  const cwd = join(dir.path, 'work')
  const agentDir = join(dir.path, 'agent')
  mkdirSync(join(cwd, '.vela'), { recursive: true })
  writeFileSync(
    join(cwd, '.vela', 'custom.json'),
    JSON.stringify({ token: 'custom' }),
  )
  const customDescriptor = {
    name: 'custom',
    projectResources: ['custom.json'],
    resolve: ({
      projectSection,
    }: {
      projectSection?: Record<string, unknown>
    }) => projectSection ?? {},
  }
  expect(projectTrustRequired(cwd, agentDir, dir.path)).toBe(false)
  expect(
    projectTrustRequired(cwd, agentDir, dir.path, [customDescriptor]),
  ).toBe(true)
  writeFileSync(
    join(cwd, '.vela', 'config.json'),
    JSON.stringify({ mcpServers: { local: { command: 'example' } } }),
  )
  expect(projectTrustRequired(cwd, agentDir, dir.path)).toBe(true)
  const bare = core.loadConfig({ cwd, agentDir, homeDir: dir.path })
  expect('mcp' in bare).toBe(false)
  const resolved = core.loadConfig({
    cwd,
    agentDir,
    homeDir: dir.path,
    trusted: true,
    extensionConfigs: [mcpConfig],
  })
  expect(resolved.extensionConfig.mcp?.mcpServers).toEqual({
    local: { command: 'example' },
  })
  const untrusted = core.loadConfig({
    cwd,
    agentDir,
    homeDir: dir.path,
    extensionConfigs: [mcpConfig],
  })
  expect(untrusted.extensionConfig.mcp?.mcpServers).toEqual({})
})
