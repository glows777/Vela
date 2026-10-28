import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '@glows777/vela-core/testing'
import { projectTrustRequired } from '../src/cli/config-helpers.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
test('core config leaves MCP to its descriptor and trusts only declared project resources', async () => {
  const core = await import('@glows777/vela-core')
  const { mcpConfig } = await import('@glows777/vela-mcp')
  const dir = tempDir('vela-config-contract-')
  cleanups.push(dir.cleanup)
  const cwd = join(dir.path, 'work')
  const agentDir = join(dir.path, 'agent')
  mkdirSync(join(cwd, '.vela'), { recursive: true })
  writeFileSync(
    join(cwd, '.vela', 'mcp.json'),
    JSON.stringify({ mcpServers: { local: { command: 'example' } } }),
  )
  expect(projectTrustRequired(cwd, agentDir, dir.path)).toBe(false)
  expect(projectTrustRequired(cwd, agentDir, dir.path, [mcpConfig])).toBe(true)
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
