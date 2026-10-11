import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCredential } from '../../../src/auth/resolve.ts'
import {
  fileCredentialStore,
  memoryCredentialStore,
} from '../../../src/auth/store.ts'
import type { OAuthCredential, OAuthLogin } from '../../../src/auth/types.ts'
import { tempDir } from '../../support/vela.ts'

const dirs: { cleanup(): void }[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})
const authFile = () => {
  const dir = tempDir('vela-auth-')
  dirs.push(dir)
  return join(dir.path, 'nested', 'auth.json')
}

test('the file store writes pi-format auth.json with mode 0600 and reads it back', async () => {
  const path = authFile()
  const store = fileCredentialStore(path)
  expect(store.get('openai')).toBeUndefined()
  await store.modify('openai', async () => ({ type: 'api_key', key: 'k' }))
  expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
    openai: { type: 'api_key', key: 'k' },
  })
  if (process.platform !== 'win32')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  // Another process's write is seen without reopening the store
  writeFileSync(
    path,
    JSON.stringify({ openai: { type: 'api_key', key: 'other' } }),
  )
  expect(fileCredentialStore(path).get('openai')).toEqual({
    type: 'api_key',
    key: 'other',
  })
  expect(store.get('openai')).toEqual({ type: 'api_key', key: 'other' })
  await store.delete('openai')
  expect(store.list()).toEqual([])
  expect(existsSync(`${path}.lock`)).toBe(false)
})

test('a broken auth.json is reported with its path', () => {
  const path = authFile()
  const store = fileCredentialStore(path)
  return store
    .modify('x', async () => undefined)
    .then(() => {
      writeFileSync(path, '{')
      expect(() => store.get('x')).toThrow('is not valid JSON')
      writeFileSync(path, '{"x":{"type":"password"}}')
      expect(() => store.get('x')).toThrow('type "api_key" or "oauth"')
    })
})

test('two stores on one file (two processes) refresh an expiring token once', async () => {
  const path = authFile()
  const expired: OAuthCredential = {
    type: 'oauth',
    access: 'old',
    refresh: 'r1',
    expires: Date.now() - 1,
  }
  await fileCredentialStore(path).modify('p', async () => expired)
  let refreshes = 0
  const oauth: OAuthLogin = {
    name: 'test',
    login: async () => expired,
    async refresh(credential) {
      refreshes++
      await new Promise((resolve) => setTimeout(resolve, 30))
      return {
        ...credential,
        access: 'new',
        refresh: 'r2',
        expires: Date.now() + 3_600_000,
      }
    },
  }
  const [a, b] = await Promise.all([
    resolveCredential(fileCredentialStore(path), 'p', oauth),
    resolveCredential(fileCredentialStore(path), 'p', oauth),
  ])
  expect(refreshes).toBe(1)
  expect(a).toMatchObject({ access: 'new' })
  expect(b).toMatchObject({ access: 'new' })
})

test('a stale lock left by a dead process is taken over', async () => {
  const path = authFile()
  const store = fileCredentialStore(path)
  await store.modify('x', async () => undefined)
  writeFileSync(`${path}.lock`, '')
  const { utimesSync } = await import('node:fs')
  const old = new Date(Date.now() - 60_000)
  utimesSync(`${path}.lock`, old, old)
  await store.modify('x', async () => ({ type: 'api_key', key: 'k' }))
  expect(store.get('x')).toEqual({ type: 'api_key', key: 'k' })
})

test('a token with time left is used as is; a failed refresh names /login and keeps the stored token', async () => {
  const fresh: OAuthCredential = {
    type: 'oauth',
    access: 'a',
    refresh: 'r',
    expires: Date.now() + 3_600_000,
  }
  const failing: OAuthLogin = {
    name: 'test',
    login: async () => fresh,
    refresh: async () => {
      throw new Error('invalid_grant')
    },
  }
  expect(
    await resolveCredential(memoryCredentialStore({ p: fresh }), 'p', failing),
  ).toBe(fresh)
  const expired = { ...fresh, expires: Date.now() + 1000 }
  const store = memoryCredentialStore({ p: expired })
  await expect(resolveCredential(store, 'p', failing)).rejects.toThrow(
    'Refreshing the OAuth token for p failed: invalid_grant. Run /login p',
  )
  expect(store.get('p')).toBe(expired)
  await expect(
    resolveCredential(memoryCredentialStore({ p: expired }), 'p', undefined),
  ).rejects.toThrow('run /login p')
})
