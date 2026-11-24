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
import { saveModel } from '../src/main/model-setup.ts'
import { readSettings } from '../src/main/settings.ts'

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vela-desktop-model-'))
  dirs.push(dir)
  return dir
}
const originals: (typeof globalThis.fetch)[] = []
const stubFetch = (
  handler: (url: string, init?: RequestInit) => Response | undefined,
) => {
  originals.push(globalThis.fetch)
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) =>
    handler(String(input), init) ??
    new Response('no stub', { status: 500 })) as typeof fetch
}
const restore = () => {
  globalThis.fetch = originals.pop() ?? globalThis.fetch
}

test('saveModel refuses a localOnly ChatGPT OAuth sign-in without a fallback API key and falls back to OPENAI_API_KEY when present', async () => {
  const dir = tempDir()
  const savedConfig = `${JSON.stringify({ model: 'anthropic/claude-opus-4-8', thinkingLevel: 'low' }, null, 2)}\n`
  const savedAuth = JSON.stringify({
    openai: {
      type: 'oauth',
      access: 'oauth-access',
      refresh: 'oauth-refresh',
      expires: Date.now() + 3600_000,
      clientId: 'client-id',
      scopes: ['chatgpt.tokens.use.direct'],
    },
  })
  writeFileSync(join(dir, 'config.json'), savedConfig)
  writeFileSync(join(dir, 'auth.json'), savedAuth)

  let requestCount = 0
  let authHeader: string | null = null
  stubFetch((url, init) => {
    requestCount += 1
    if (url.startsWith('https://api.openai.com/v1/responses')) {
      authHeader = new Headers(init?.headers).get('authorization')
      return Response.json({
        id: 'resp_1',
        created_at: 0,
        model: 'gpt-5-mini',
        output: [
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'OK', annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }
  })
  try {
    await expect(
      saveModel({
        agentDir: dir,
        input: { provider: 'openai', model: 'gpt-5-mini' },
        env: {},
      }),
    ).rejects.toThrow(/only for the local terminal, not for local/)
    expect(requestCount).toBe(0)
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(savedConfig)
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe(savedAuth)

    await saveModel({
      agentDir: dir,
      input: { provider: 'openai', model: 'gpt-5-mini' },
      env: { OPENAI_API_KEY: 'sk-fallback' },
    })
    expect(requestCount).toBe(1)
    expect(authHeader).toBe('Bearer sk-fallback')
    expect(
      JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).model,
    ).toBe('openai/gpt-5-mini')
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe(savedAuth)
  } finally {
    restore()
  }
})

test('readSettings ignores localOnly OAuth for setup and credential status unless a fallback API key exists', () => {
  const dir = tempDir()
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ model: 'openai/gpt-5' }),
  )
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({
      openai: {
        type: 'oauth',
        access: 'oauth-access',
        refresh: 'oauth-refresh',
        expires: Date.now() + 3600_000,
        clientId: 'client-id',
      },
    }),
  )
  const prevKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    const blocked = readSettings({
      agentDir: dir,
      cwd: dir,
      larkLoaded: false,
      directModel: false,
      hasAvailableModel: false,
    })
    expect(blocked.setup).toEqual({
      required: true,
      reason: 'missing-credential',
      provider: 'openai',
    })
    expect(
      blocked.providers.find((p) => p.name === 'openai')?.credential,
    ).toBeUndefined()

    process.env.OPENAI_API_KEY = 'sk-fallback'
    const fallback = readSettings({
      agentDir: dir,
      cwd: dir,
      larkLoaded: false,
      directModel: false,
      hasAvailableModel: false,
    })
    expect(fallback.setup).toEqual({ required: false })
    expect(
      fallback.providers.find((p) => p.name === 'openai')?.credential,
    ).toBe('OPENAI_API_KEY')
  } finally {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
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
    for (const name of ['auth.json', 'config.json'])
      expect(existsSync(join(dir, name)), name).toBe(false)
  } finally {
    restore()
  }
})

afterAll(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
