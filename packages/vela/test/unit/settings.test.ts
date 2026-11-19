import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fileCredentialStore,
  loadModels,
  memoryCredentialStore,
} from '@glows777/vela-core'
import {
  saveLarkSection,
  saveModelSetup,
  usableModel,
} from '../../src/settings.ts'

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vela-settings-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

test('a saved model writes the credential, the custom provider and the settings', async () => {
  const dir = tempDir()
  const preset = {
    api: 'openai-completions' as const,
    baseUrl: 'https://example.invalid/v1',
    models: [{ id: 'custom-model' }],
  }
  const providers = loadModels({
    agentDir: dir,
    env: {},
    overrides: { custom: preset },
  })
  const saved = await saveModelSetup({
    agentDir: dir,
    ref: 'custom/custom-model',
    providers,
    credential: { type: 'api_key', key: 'secret-key' },
    preset,
    thinkingLevel: 'high',
  })
  expect(saved.written).toEqual([
    join(dir, 'auth.json'),
    join(dir, 'models.json'),
    join(dir, 'settings.json'),
  ])
  expect(saved.definition).toBe(providers.custom!)
  expect(fileCredentialStore(join(dir, 'auth.json')).get('custom')).toEqual({
    type: 'api_key',
    key: 'secret-key',
  })
  expect(JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'))).toEqual({
    providers: { custom: preset },
  })
  expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({
    defaultModel: 'custom/custom-model',
    defaultThinkingLevel: 'high',
  })
  expect(statSync(join(dir, 'auth.json')).mode & 0o777).toBe(0o600)
  expect(statSync(join(dir, 'settings.json')).mode & 0o777).toBe(0o600)
})

test('a saved model keeps the files and the thinking level it was not given', async () => {
  const dir = tempDir()
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ defaultThinkingLevel: 'low', shellPath: '/bin/bash' }),
  )
  const saved = await saveModelSetup({
    agentDir: dir,
    ref: 'anthropic/claude-opus-4-8',
    providers: loadModels({ agentDir: dir, env: {} }),
  })
  expect(saved.written).toEqual([join(dir, 'settings.json')])
  expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({
    defaultThinkingLevel: 'low',
    shellPath: '/bin/bash',
    defaultModel: 'anthropic/claude-opus-4-8',
  })
  expect(existsSync(join(dir, 'auth.json'))).toBe(false)
  expect(existsSync(join(dir, 'models.json'))).toBe(false)
})

test('the Lark section adds, removes and escapes without losing the other keys', async () => {
  const dir = tempDir()
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      extensionConfig: {
        lark: {
          owners: ['owner'],
          chats: [{ id: 'old', tools: ['read_file'] }, '$LARK_SETUP_CHAT'],
        },
      },
    }),
  )
  const env = { LARK_SETUP_CHAT: 'from-env' }
  const lark = () =>
    JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).extensionConfig
      .lark
  await saveLarkSection({
    agentDir: dir,
    appId: 'app-id',
    appSecret: 'sec$ret',
    addChat: 'new',
    env,
  })
  expect(lark()).toEqual({
    owners: ['owner'],
    chats: [{ id: 'old', tools: ['read_file'] }, '$LARK_SETUP_CHAT', 'new'],
    appId: 'app-id',
    appSecret: 'sec$$ret',
  })
  // A chat the environment expression already names stays as it is, not duplicated.
  await saveLarkSection({ agentDir: dir, addChat: 'from-env', env })
  expect(lark().chats).toEqual([
    { id: 'old', tools: ['read_file'] },
    '$LARK_SETUP_CHAT',
    'new',
  ])
  await saveLarkSection({
    agentDir: dir,
    removeChat: 'old',
    runInApp: false,
    env,
  })
  expect(lark()).toEqual({
    owners: ['owner'],
    chats: ['$LARK_SETUP_CHAT', 'new'],
    appId: 'app-id',
    appSecret: 'sec$$ret',
    runInApp: false,
  })
})

test('an enabled chat saved as an environment expression is not rewritten', async () => {
  const dir = tempDir()
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ extensionConfig: { lark: { chats: '$LARK_CHATS' } } }),
  )
  await expect(
    saveLarkSection({ agentDir: dir, addChat: 'new' }),
  ).rejects.toThrow('environment expression')
  expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({
    extensionConfig: { lark: { chats: '$LARK_CHATS' } },
  })
})

test('a model is usable when its provider has a credential', async () => {
  const dir = tempDir()
  const providers = loadModels({ agentDir: dir, env: {} })
  const credentials = memoryCredentialStore()
  expect(usableModel({ providers, credentials })).toEqual({
    usable: false,
    reason: 'no-model',
  })
  expect(
    usableModel({ providers, credentials, model: 'faux/faux-model' }),
  ).toEqual({ usable: true, provider: 'faux' })
  expect(
    usableModel({ providers, credentials, model: 'anthropic/claude-opus-4-8' }),
  ).toEqual({
    usable: false,
    reason: 'missing-credential',
    provider: 'anthropic',
  })
  await credentials.modify('anthropic', async () => ({
    type: 'api_key',
    key: 'key',
  }))
  expect(
    usableModel({ providers, credentials, model: 'anthropic/claude-opus-4-8' }),
  ).toEqual({ usable: true, provider: 'anthropic' })
})
