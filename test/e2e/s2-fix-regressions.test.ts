import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import { projectDataDir } from '../../packages/vela/src/driver/config/paths.ts'
import { SessionStore } from '../../packages/vela/src/driver/session/index.ts'
import {
  fauxText,
  fauxToolCall,
} from '../../packages/vela/src/testing/core/index.ts'
import { cleanupTestVelas, createTestVela, tempDir } from '../support/vela.ts'

const ROOT = resolve(import.meta.dir, '../..')
const CLI_ENTRY = join(ROOT, 'packages/vela/src/cli/main.ts')
const cleanups: Array<() => void> = []

afterEach(() => {
  cleanupTestVelas()
  while (cleanups.length) cleanups.pop()?.()
})

test('oauth producer suffix flows to context hooks and CLI --export reads vela.db directly in readonly mode without models or extensions', async () => {
  const project = tempDir('vela-s2fix-proj-')
  const agentDir = tempDir('vela-s2fix-agent-')
  cleanups.push(project.cleanup, agentDir.cleanup)
  const outHtml = join(project.path, 'out.html')
  const outJsonl = join(project.path, 'out.jsonl')

  let contextCalls = 0
  const t = createTestVela({
    cwd: project.path,
    responses: [
      fauxToolCall('tc-img', 'img_tool', {}),
      fauxText('Done inspecting image'),
    ],
    extensions: [
      (api) => {
        api.registerTool({
          name: 'img_tool',
          description: 'returns inline image',
          inputSchema: z.object({}),
          execute: async () => [
            { type: 'text', text: 'image ready' },
            { type: 'image', data: 'QUJD', mimeType: 'image/png' },
          ],
        })
        api.on('context', () => {
          contextCalls++
        })
      },
    ],
  })

  // Seed a saved channel session with an inline user image directly into vela.db
  const dataDir = projectDataDir(agentDir.path, project.path)
  mkdirSync(dataDir, { recursive: true })
  const db = openDatabase({ path: join(dataDir, 'vela.db') })
  try {
    const store = new SessionStore('cli-export-s', db, { cwd: project.path })
    store.setChannel('lark')
    store.appendMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'look at image' },
        { type: 'image', data: 'QUJD', mimeType: 'image/png' },
      ],
    })
    store.appendMessage({ role: 'assistant', content: 'looks good' })
  } finally {
    db.close()
  }

  // No API key configured in config/env: proves `--export` skips model & extension startup
  await Bun.write(
    join(agentDir.path, 'config.json'),
    JSON.stringify({ model: 'openai/does-not-need-key' }),
  )

  const env = {
    ...process.env,
    VELA_DIR: agentDir.path,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
  }

  // 1) --export to .html renders [image: image/png] directly from vela.db
  const htmlProc = Bun.spawnSync(
    ['bun', CLI_ENTRY, '--export', 'cli-export-s', outHtml],
    { cwd: project.path, env },
  )
  expect(htmlProc.exitCode).toBe(0)
  expect(existsSync(outHtml)).toBe(true)
  const html = readFileSync(outHtml, 'utf8')
  expect(html).toContain('[image: image/png]')
  expect(html).toContain('looks good')

  // 2) --export to .jsonl emits SessionHeader with channel
  const jsonlProc = Bun.spawnSync(
    ['bun', CLI_ENTRY, '--export', 'cli-export-s', outJsonl],
    { cwd: project.path, env },
  )
  expect(jsonlProc.exitCode).toBe(0)
  expect(existsSync(outJsonl)).toBe(true)
  const header = JSON.parse(readFileSync(outJsonl, 'utf8').split('\n')[0]!) as {
    channel?: string
    version?: number
  }
  expect(header.version).toBe(2)
  expect(header.channel).toBe('lark')

  // 3) --export combined with --no-session exits non-zero cleanly
  const noSessionProc = Bun.spawnSync(
    ['bun', CLI_ENTRY, '--no-session', '--export', 'cli-export-s', outHtml],
    { cwd: project.path, env },
  )
  expect(noSessionProc.exitCode).toBe(1)

  await t.run('call img_tool')
  expect(contextCalls).toBe(2)
})
