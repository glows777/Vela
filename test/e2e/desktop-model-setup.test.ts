import { afterAll, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveModel } from '../../apps/desktop/src/main/model-setup.ts'

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vela-desktop-model-'))
  dirs.push(dir)
  return dir
}
const originals: (typeof globalThis.fetch)[] = []
const stubFetch = (handler: (url: string) => Response | undefined) => {
  originals.push(globalThis.fetch)
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) =>
    handler(String(input)) ??
    new Response('no stub', { status: 500 })) as typeof fetch
}
const restore = () => {
  globalThis.fetch = originals.pop() ?? globalThis.fetch
}

/**
 * Using a saved sign-in refreshes it when it is about to expire, and OpenAI rotates the refresh
 * token on every refresh. A model the provider then refuses must not throw that rotation away:
 * the next run would have no sign-in left. A key typed in that same request is not saved, and the
 * saved model is not changed.
 */
test('a sign-in refreshed during a refused check is still saved', async () => {
  const dir = tempDir()
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({
      openai: {
        type: 'oauth',
        access: 'old-access',
        refresh: 'old-refresh',
        expires: Date.now() + 30_000,
        clientId: 'client-id',
        scopes: ['chatgpt.tokens.use.direct'],
      },
    }),
  )
  stubFetch((url) => {
    if (url === 'https://auth.openai.com/api/accounts/oauth/token')
      return Response.json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'chatgpt.tokens.use.direct openid',
      })
    // The signed-in ChatGPT path only talks to OpenAI's own endpoint, so the probe is stubbed there.
    if (url.startsWith('https://api.openai.com/v1/responses'))
      return Response.json(
        { error: { message: 'invalid model', type: 'invalid_request_error' } },
        { status: 400 },
      )
  })
  try {
    await expect(
      saveModel({
        agentDir: dir,
        input: { provider: 'openai', model: 'gpt-5.5' },
        env: {},
      }),
    ).rejects.toThrow('invalid model')
    const auth = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))
    expect(auth.openai.refresh).toBe('new-refresh')
    expect(auth.openai.access).toBe('new-access')
    // The refused model is not saved.
    expect(existsSync(join(dir, 'settings.json'))).toBe(false)
  } finally {
    restore()
  }
})

test('a typed key is not saved when the check refuses it', async () => {
  const dir = tempDir()
  stubFetch((url) =>
    url.startsWith('https://verify.invalid/v1/chat/completions')
      ? Response.json(
          { error: { message: 'invalid api key' } },
          { status: 401 },
        )
      : undefined,
  )
  try {
    await expect(
      saveModel({
        agentDir: dir,
        input: {
          provider: 'faux',
          model: 'faux-model',
          key: 'wrong-key',
          custom: {
            api: 'openai-completions',
            baseUrl: 'https://verify.invalid/v1',
          },
        },
        env: {},
      }),
    ).rejects.toThrow('invalid api key')
    for (const name of ['auth.json', 'settings.json', 'models.json'])
      expect(existsSync(join(dir, name)), name).toBe(false)
  } finally {
    restore()
  }
})

afterAll(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
