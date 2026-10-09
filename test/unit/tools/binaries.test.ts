import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'
import type { VelaLogger } from '../../../src/logger.ts'
import { createBinaryResolver } from '../../../src/tools/binaries.ts'

// A local stand-in for github.com: /releases/latest redirects to the tag, the asset is a tar.gz
// with the binary nested in a versioned directory, like the real ripgrep / fd releases.
const root = mkdtempSync(join(tmpdir(), 'vela-binaries-'))
const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${
  process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'
}`
const requests: string[] = []
let server: ReturnType<typeof Bun.serve>
let archive: Uint8Array

beforeAll(async () => {
  const stage = join(root, 'stage', `ripgrep-14.1.1-${target}`)
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, 'rg'), '#!/bin/sh\necho fake-rg\n')
  await $`tar czf ${join(root, 'rg.tar.gz')} -C ${join(root, 'stage')} .`
  archive = new Uint8Array(
    await Bun.file(join(root, 'rg.tar.gz')).arrayBuffer(),
  )
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      requests.push(path)
      if (path === '/BurntSushi/ripgrep/releases/latest')
        return new Response(null, {
          status: 302,
          headers: { location: '/BurntSushi/ripgrep/releases/tag/14.1.1' },
        })
      if (
        path ===
        `/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-${target}.tar.gz`
      )
        return new Response(archive)
      return new Response('not found', { status: 404 })
    },
  })
})
afterAll(() => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

// PATH holds only tar (and the gzip it runs), so rg / fd are "not installed"
const originalPath = process.env.PATH
const onlyTar = join(root, 'path')
mkdirSync(onlyTar, { recursive: true })
for (const command of ['tar', 'gzip'])
  symlinkSync(Bun.which(command)!, join(onlyTar, command))
const withoutPrograms = () => {
  process.env.PATH = onlyTar
}
afterEach(() => {
  process.env.PATH = originalPath
  requests.length = 0
})

const logs: string[] = []
const logger: VelaLogger = {
  debug: () => {},
  info: (m) => logs.push(m),
  warn: (m) => logs.push(m),
  error: (m) => logs.push(m),
}

test('found on PATH: returned as is, nothing downloaded', async () => {
  const fakeBin = mkdtempSync(join(root, 'bin-'))
  writeFileSync(join(fakeBin, 'fdfind'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(fakeBin, 'fdfind'), 0o755)
  process.env.PATH = `${fakeBin}:${onlyTar}`
  const resolve = createBinaryResolver({
    binDir: join(root, 'unused'),
    releaseBaseUrl: server.url.origin,
  })
  // Debian/Ubuntu name fd `fdfind`
  expect(await resolve('fd')).toBe('fdfind')
  expect(requests).toEqual([])
})

test('missing: downloads the latest release into binDir once, then uses it', async () => {
  withoutPrograms()
  const binDir = join(root, 'bin-download')
  const resolve = createBinaryResolver({
    binDir,
    logger,
    releaseBaseUrl: server.url.origin,
  })
  const [a, b] = await Promise.all([resolve('rg'), resolve('rg')])
  expect(a).toBe(join(binDir, 'rg'))
  expect(b).toBe(a)
  expect((await $`${a}`.text()).trim()).toBe('fake-rg')
  expect(requests).toHaveLength(2) // latest + asset, once for both calls
  expect(logs.at(-1)).toContain(`ripgrep installed to ${a}`)

  // A new resolver (next CLI start) finds it in binDir without the network
  requests.length = 0
  expect(
    await createBinaryResolver({ binDir, releaseBaseUrl: server.url.origin })(
      'rg',
    ),
  ).toBe(a)
  expect(requests).toEqual([])
  // nothing left behind but the binary
  expect(existsSync(join(binDir, 'rg'))).toBe(true)
  expect([...new Bun.Glob('*').scanSync({ cwd: binDir, dot: true })]).toEqual([
    'rg',
  ])
})

test('missing without binDir or offline: an error that says how to install', async () => {
  withoutPrograms()
  await expect(createBinaryResolver()('rg')).rejects.toThrow(
    /ripgrep \(rg\) is not installed\. Install it \(brew install ripgrep/,
  )
  await expect(
    createBinaryResolver({
      binDir: join(root, 'bin-offline'),
      offline: true,
      releaseBaseUrl: server.url.origin,
    })('fd'),
  ).rejects.toThrow(
    /fd \(fd\) is not installed and VELA_OFFLINE is set.*apt install fd-find/,
  )
  expect(requests).toEqual([])
})

test('a failed download is an error, and the next call tries again', async () => {
  withoutPrograms()
  const resolve = createBinaryResolver({
    binDir: join(root, 'bin-fail'),
    releaseBaseUrl: server.url.origin,
  })
  // the fake server has no fd release
  await expect(resolve('fd')).rejects.toThrow(
    /fd \(fd\) is not installed and could not be downloaded \(could not resolve the latest sharkdp\/fd release \(HTTP 404\)\)/,
  )
  await expect(resolve('fd')).rejects.toThrow('could not be downloaded')
  expect(requests).toHaveLength(2)
})
