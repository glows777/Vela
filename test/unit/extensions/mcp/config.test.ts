import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadMcpServers,
  parseServers,
  toolExposureOf,
} from '../../../../src/extensions/mcp/config.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function setup(user?: unknown, project?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'vela-mcp-config-'))
  dirs.push(root)
  const agentDir = join(root, 'agent')
  const projectDir = join(root, 'project', '.vela')
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  if (user !== undefined)
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify(user))
  if (project !== undefined)
    writeFileSync(join(projectDir, 'mcp.json'), JSON.stringify(project))
  return { agentDir, projectDir }
}

test('invalid entries are reported and skipped; the rest are kept', () => {
  const { entries, errors } = parseServers({
    ok: { command: 'npx', args: ['-y', 'server'] },
    web: { url: 'https://example.com/mcp', headers: { A: 'b' } },
    'bad name': { command: 'x' },
    none: {},
    both: { command: 'x', url: 'https://example.com/mcp' },
    sse: { type: 'sse', url: 'https://example.com/sse' },
    code: { command: 'x', exposure: 'codemode' },
    tool: { command: 'x', toolExposure: { a: 'codemode-deferred' } },
    timeout: { command: 'x', timeout: 0 },
    ok_: { command: 'x' },
    'ok-': { command: 'x' },
  })
  expect(entries.map((e) => e.name)).toEqual(['ok', 'web', 'ok_'])
  expect(errors).toEqual([
    'MCP server "bad name": names may contain only letters, digits, "_" and "-"',
    'MCP server "none": needs a command (stdio) or a url (HTTP)',
    'MCP server "both": set either command (stdio) or url (HTTP), not both',
    'MCP server "sse": the legacy SSE transport is not supported; use the streamable HTTP endpoint (often /mcp instead of /sse)',
    'MCP server "code": exposure "codemode" is not available: Vela has no codemode yet. Use "deferred" (tool_search loads the tools) or "direct"',
    'MCP server "tool": toolExposure["a"] "codemode-deferred" is not available: Vela has no codemode yet. Use "deferred" (tool_search loads the tools) or "direct"',
    'MCP server "timeout": timeout must be a positive number of seconds',
    'MCP server "ok-": clashes with "ok_" (names differing only in "-" and "_" are the same server)',
  ])
})

test('toolExposure: exact names win over patterns, then the first matching pattern, then the server exposure', () => {
  const config = {
    command: 'x',
    exposure: 'deferred' as const,
    toolExposure: {
      'get_*': 'hidden' as const,
      '*_file': 'direct' as const,
      get_file: 'direct' as const,
    },
  }
  expect(toolExposureOf(config, 'get_file')).toBe('direct')
  expect(toolExposureOf(config, 'get_dir')).toBe('hidden')
  expect(toolExposureOf(config, 'put_file')).toBe('direct')
  expect(toolExposureOf(config, 'list')).toBe('deferred')
  expect(toolExposureOf({ command: 'x' }, 'list')).toBe('deferred')
})

test('project mcp.json is read only when trusted; an entry without command/url/type only overrides enabled and exposure', () => {
  const { agentDir, projectDir } = setup(
    {
      mcpServers: {
        docs: {
          url: 'https://docs/mcp',
          headers: { Authorization: 'Bearer ${TOKEN}' },
        },
        tools: { command: 'tools' },
      },
    },
    {
      mcpServers: {
        docs: { enabled: false, url_typo: 'ignored', exposure: 'direct' },
        tools: { command: 'project-tools' },
        local: { command: 'local' },
      },
    },
  )
  const env = { TOKEN: 'secret' }
  expect(
    loadMcpServers({ agentDir, projectDir, trusted: false, env }).servers,
  ).toEqual({
    docs: {
      url: 'https://docs/mcp',
      headers: { Authorization: 'Bearer secret' },
    },
    tools: { command: 'tools' },
  })
  const trusted = loadMcpServers({ agentDir, projectDir, trusted: true, env })
  expect(trusted.servers).toEqual({
    docs: {
      url: 'https://docs/mcp',
      headers: { Authorization: 'Bearer secret' },
      enabled: false,
      exposure: 'direct',
    },
    tools: { command: 'project-tools' },
    local: { command: 'local' },
  })
  expect(trusted.sources.docs).toBe(join(projectDir, 'mcp.json'))
  expect(trusted.sources.local).toBe(join(projectDir, 'mcp.json'))
  expect(trusted.errors).toEqual([])
})

test('an unset variable or a broken file is an error, not an empty value', () => {
  const { agentDir, projectDir } = setup(
    {
      mcpServers: {
        docs: {
          url: 'https://docs/mcp',
          headers: { Authorization: 'Bearer ${TOKEN}' },
        },
        ok: { command: 'x', env: { A: '$$literal' } },
      },
    },
    'not json',
  )
  writeFileSync(join(projectDir, 'mcp.json'), '{ broken')
  const result = loadMcpServers({
    agentDir,
    projectDir,
    trusted: true,
    env: {},
  })
  expect(result.servers).toEqual({
    ok: { command: 'x', env: { A: '$literal' } },
  })
  expect(result.errors[0]).toBe(
    'MCP server "docs" headers "Authorization" uses ${TOKEN}, which is not set',
  )
  expect(result.errors[1]).toStartWith(`${join(projectDir, 'mcp.json')}: `)
})
