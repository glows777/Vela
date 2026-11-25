import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  createVela,
  memoryCredentialStore,
  ToolExecutionResult,
} from '@glows777/vela'
import { createFauxModel, fauxText, fauxToolCall } from '@glows777/vela/testing'
import { z } from 'zod'
import { openDatabase } from '../../packages/vela/src/db/sqlite.ts'
import { projectDataDir } from '../../packages/vela/src/driver/config/paths.ts'
import { SessionStore } from '../../packages/vela/src/driver/session/index.ts'
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

  const PNG_1X1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

  let contextCalls = 0
  let imgToolName = ''
  const t = createTestVela({
    cwd: project.path,
    responses: [
      () => fauxToolCall(imgToolName, {}, { id: 'tc-img' }),
      fauxText('Done inspecting image'),
    ],
    extensions: [
      (api) => {
        imgToolName = api.registerTool({
          name: 'img_tool',
          description: 'returns inline image',
          inputSchema: z.object({}),
          execute: async () =>
            new ToolExecutionResult({ ok: true }, [
              { type: 'text', text: 'image ready' },
              { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
            ]),
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
  const toolEnds = t.eventsOf('tool_execution_end')
  expect(toolEnds).toHaveLength(1)
  expect(toolEnds[0]?.toolName).toBe(imgToolName)
  expect(toolEnds[0]?.isError).toBe(false)
  expect(JSON.stringify(toolEnds[0]?.result)).toContain('image/png')

  // 4) Real OAuth credential adds `:oauth` producer suffix and reflects mid-run logout on the next step
  const creds = memoryCredentialStore({
    openai: {
      type: 'oauth',
      access: 'oauth-tok-1',
      refresh: 'oauth-ref-1',
      expires: Date.now() + 60_000,
    },
  })
  let switchToolName = ''
  const oauthFaux = createFauxModel({
    responses: [
      () =>
        fauxToolCall(
          switchToolName,
          {},
          { id: 'tc-oauth-1', reasoning: 'step-1-thinking' },
        ),
      fauxText('switched away from oauth'),
    ],
  })
  const seenSnapshots: string[] = []
  const dataDirOAuth = tempDir('vela-s2fix-oauth-')
  cleanups.push(dataDirOAuth.cleanup)
  const velaOAuth = createVela({
    cwd: project.path,
    dataDir: dataDirOAuth.path,
    credentials: creds,
    model: 'openai/gpt-4o',
    providers: {
      openai: {
        models: [{ id: 'gpt-4o', name: 'gpt-4o', reasoning: true }],
        authSource: (c) => (c ? 'stored' : undefined),
        createModel: () => oauthFaux,
      },
    },
    extensions: [
      (api) => {
        switchToolName = api.registerTool({
          name: 'switch_creds',
          description: 'logs out oauth mid-run',
          inputSchema: z.object({}),
          execute: async () => {
            await creds.delete('openai')
            return 'logged out'
          },
        })
        api.on('context', (event) => {
          seenSnapshots.push(JSON.stringify(event.messages))
        })
      },
    ],
  })
  try {
    const s = velaOAuth.session('oauth-dyn')
    await s.prompt('run switch_creds')
    expect(seenSnapshots).toHaveLength(2)
    // After OAuth was deleted mid-run, step 2 recomputes producer without `:oauth`
    // and strips step 1's reasoning part that came from `openai/gpt-4o:oauth`.
    expect(seenSnapshots[1]).not.toContain('step-1-thinking')
    const verifyDb = openDatabase({
      path: join(dataDirOAuth.path, 'vela.db'),
      readonly: true,
    })
    try {
      const assistantProducers = verifyDb
        .all<{ produced_by: string | null }>(
          "SELECT produced_by FROM vela_messages WHERE session_id = 'oauth-dyn' AND role = 'assistant' ORDER BY seq ASC",
        )
        .map((r) => r.produced_by)
      expect(assistantProducers).toEqual(['faux/faux:oauth', 'faux/faux'])
    } finally {
      verifyDb.close()
    }
  } finally {
    await velaOAuth.dispose()
  }
})
