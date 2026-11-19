import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join, posix } from 'node:path'
import {
  createLocalExecutionEnv,
  createVela,
  type ExecutionEnv,
} from '@glows777/vela'
import { createFauxModel, fauxText, tempDir } from '@glows777/vela/testing'
import { drainChannels } from '@glows777/vela-channels/testing'
import { lark } from '@glows777/vela-lark'
import { fakeLark, larkEvent } from '../support/lark.ts'

function guest(root: string, name: string) {
  const cwd = '/workspace',
    home = '/guest-home',
    disk = join(root, name)
  mkdirSync(join(disk, cwd), { recursive: true })
  const files = createLocalExecutionEnv({ cwd: disk })
  const absolute = (p: string) =>
    posix.resolve(cwd, p.replace(/^~(?=\/|$)/, home))
  const path = (p: string) => join(disk, absolute(p))
  let writes = 0,
    failRename = false
  const env: ExecutionEnv = {
    ...files,
    id: 'fixture:' + name,
    cwd,
    absolutePath: async (p) => ({ ok: true, value: absolute(p) }),
    joinPath: async (parts) => ({ ok: true, value: posix.join(...parts) }),
    canonicalPath: async (p) => {
      const r = await files.canonicalPath(path(p))
      return r.ok ? { ok: true, value: absolute(p) } : r
    },
    fileInfo: (p) => files.fileInfo(path(p)),
    exists: (p) => files.exists(path(p)),
    listDir: (p) => files.listDir(path(p)),
    readTextFile: (p) => files.readTextFile(path(p)),
    readBinaryFile: (p) => files.readBinaryFile(path(p)),
    openBinaryReader: (p, o, s) => files.openBinaryReader(path(p), o, s),
    createDir: (p, o) => files.createDir(path(p), o),
    writeFile: (p, b) => {
      writes++
      return files.writeFile(path(p), b)
    },
    renameFile: async (a, b) =>
      failRename
        ? {
            ok: false,
            error: Object.assign(
              Error('rename unavailable at /synthetic/owner/path'),
              {
                code: 'unavailable' as const,
              },
            ),
          }
        : files.renameFile(path(a), path(b)),
    remove: (p, o) => files.remove(path(p), o),
    cleanup: async () => {},
  }
  return {
    env,
    path,
    writes: () => writes,
    failRename: (fail: boolean) => {
      failRename = fail
    },
  }
}

test('non-local file redelivery reuses the canonical upload, and forks copy only referenced uploads into the selected workspace', async () => {
  const dir = tempDir(),
    blue = guest(dir.path, 'blue'),
    green = guest(dir.path, 'green')
  const dataDir = join(dir.path, 'data'),
    bytes = Buffer.from([0, 255, 99])
  const topic = { root_id: 'root', thread_id: 'thread' },
    name = 'notes.bin',
    key = 'binary'
  function start() {
    const fake = fakeLark(),
      model = createFauxModel({ responses: [fauxText('accepted')] })
    const vela = createVela({
      cwd: dir.path,
      dataDir,
      model,
      env: ({ location }) =>
        location.environment === 'blue' ? blue.env : green.env,
      extensions: [lark({ appId: 'bot', transport: fake.transport })],
      extensionConfig: {
        lark: { chats: [{ id: 'oc_group', environment: 'blue' }] },
      },
    })
    async function deliver(messageId: string) {
      fake.deliver(
        larkEvent({
          ...topic,
          message_id: messageId,
          message_type: 'file',
          content: JSON.stringify({ file_key: key, file_name: name }),
        }),
      )
      for (let n = 0; n < 200 && !fake.sent.length; n++) await Bun.sleep(10)
      await drainChannels(vela)
      return fake.sent.map((s) => s.text).join(' ')
    }
    return { fake, model, vela, deliver }
  }
  let h = start()
  try {
    await h.vela.startChannels()
    h.fake.resources.set(key, [bytes])
    blue.failRename(true)
    expect(await h.deliver('upload')).not.toContain('/synthetic/owner/path')
    expect(h.model.calls).toHaveLength(0)
    const s = h.vela.sessions().find((s) => s.location.environment === 'blue')!
    const rel = (id: string) =>
      posix.join('/guest-home/.vela/uploads', id, 'upload-notes.bin')
    expect(existsSync(blue.path(rel(s.id)))).toBe(false)
    const cacheDir = blue.path(posix.dirname(rel(s.id)))
    expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([])
    expect(h.fake.resourceCalls).toHaveLength(1)
    await h.vela.dispose()
    h = start()
    blue.failRename(false)
    await h.vela.startChannels()
    expect(await h.deliver('upload')).toContain('accepted')
    expect(h.fake.resourceCalls).toHaveLength(0)
    const beforeReplay = blue.writes()
    await h.vela.dispose()
    h = start()
    await h.vela.startChannels()
    expect(await h.deliver('upload')).toContain('accepted')
    expect(h.fake.resourceCalls).toHaveLength(0)
    expect(blue.writes()).toBe(beforeReplay)
    const parent = h.vela.session(s.id),
      original = rel(s.id)
    expect(h.model.calls.at(-1)!.lastUserText).toContain(original)
    expect(h.model.calls.at(-1)!.lastUserText).not.toContain(dir.path)
    expect(readFileSync(blue.path(original))).toEqual(bytes)
    const cached = Buffer.from('edited in blue')
    writeFileSync(blue.path(original), cached)
    const first = parent
      .getEntries()
      .find((e) => e.type === 'message' && e.message.role === 'user')!
    const same = (
      await parent.fork(first.id, { position: 'at', sessionId: 'same' })
    ).session!
    expect(JSON.stringify(same.messages)).toContain(rel('same'))
    expect(readFileSync(blue.path(rel('same')))).toEqual(cached)
    await parent.setLocation({ environment: 'green', cwd: '/workspace' })
    const moved = (await parent.clone({ sessionId: 'moved' })).session!
    expect(moved.location.environment).toBe('green')
    expect(JSON.stringify(moved.messages)).toContain(rel('moved'))
    expect(readFileSync(green.path(rel('moved')))).toEqual(bytes)
    expect(existsSync(blue.path(rel('moved')))).toBe(false)
    const outside = join(dir.path, 'invented.bin')
    await moved.sendMessage({
      customType: 'note',
      content: `[file: rumor, saved at ${outside}]`,
      display: false,
    })
    const nested = (await moved.clone({ sessionId: 'nested' })).session!
    expect(readFileSync(green.path(rel(nested.id)))).toEqual(bytes)
    expect(existsSync(outside)).toBe(false)
  } finally {
    await h.vela.dispose()
    dir.cleanup()
  }
})
