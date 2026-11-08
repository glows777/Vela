import { afterEach, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalStore } from '../../src/local-store.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vela-local-store-'))
  roots.push(root)
  const cwd = join(root, 'project')
  await mkdir(cwd)
  const data = join(root, 'data')
  const store = new LocalStore(data)
  await store.load()
  return { root, cwd, data, store }
}

test('canonical aliases and concurrent opens reuse opaque project identity across restart', async () => {
  const { root, cwd, data, store } = await fixture()
  const alias = join(root, 'alias')
  await symlink(cwd, alias)
  const [first, second] = await Promise.all([
    store.openProject(cwd),
    store.openProject(alias),
  ])
  expect(second).toEqual(first)
  expect(first.cwd).toBe(cwd)
  expect(first.id).not.toContain(cwd)
  const again = new LocalStore(data)
  await again.load()
  expect(again.deploymentId).toBe(store.deploymentId)
  expect(await again.openProject(alias)).toEqual(first)
  expect(again.projects()).toHaveLength(1)
})

test('concurrent appends persist without loss and return detached visible messages', async () => {
  const { cwd, data, store } = await fixture()
  const project = await store.openProject(cwd)
  const messages = await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      store.append(project.id, {
        sessionId: project.sessionId,
        role: 'user',
        text: `${i}`,
        clientMessageId: `c${i}`,
      }),
    ),
  )
  messages[0]!.text = 'changed'
  const visible = store.messages(project.id, project.sessionId)
  expect(visible).toHaveLength(15)
  expect(visible[0]!.text).toBe('0')
  visible.pop()
  store.project(project.id)!.cwd = 'changed'
  store.projects()[0]!.name = 'changed'
  expect(store.project(project.id)).toEqual(project)
  expect(store.messages(project.id, 'other')).toEqual([])
  const again = new LocalStore(data)
  await again.load()
  expect(again.messages(project.id, project.sessionId)).toEqual(
    store.messages(project.id, project.sessionId),
  )
  expect(
    JSON.parse(
      await readFile(join(data, 'local', `${project.id}.json`), 'utf8'),
    ),
  ).toHaveLength(15)
})

test('failed log writes preserve memory and later mutations recover', async () => {
  const { cwd, data, store } = await fixture()
  const project = await store.openProject(cwd)
  const message = await store.append(project.id, {
    sessionId: project.sessionId,
    role: 'user',
    text: 'kept',
  })
  const log = join(data, 'local', `${project.id}.json`)
  await rename(log, `${log}.saved`)
  await mkdir(log)
  await expect(
    store.append(project.id, {
      sessionId: project.sessionId,
      role: 'assistant',
      text: 'lost',
    }),
  ).rejects.toThrow()
  await expect(store.remove(project.id, message.id)).rejects.toThrow()
  expect(store.messages(project.id, project.sessionId)).toEqual([message])
  await rm(log, { recursive: true })
  await rename(`${log}.saved`, log)
  await store.remove(project.id, message.id)
  expect(store.messages(project.id, project.sessionId)).toEqual([])
})

test('failed registry write does not expose a project', async () => {
  const { cwd, data, store } = await fixture()
  const registry = join(data, 'local', 'projects.json')
  await rename(registry, `${registry}.saved`)
  await mkdir(registry)
  await expect(store.openProject(cwd)).rejects.toThrow()
  expect(store.projects()).toEqual([])
})

test('malformed registry and traversal IDs are rejected without reset', async () => {
  const { data, store } = await fixture()
  const registry = join(data, 'local', 'projects.json')
  for (const text of [
    '{',
    JSON.stringify({
      version: 1,
      deploymentId: store.deploymentId,
      projects: [
        {
          id: '../outside',
          cwd: '/tmp',
          name: 'bad',
          sessionId: 'bad',
          channel: 'local',
        },
      ],
    }),
  ]) {
    await writeFile(registry, text)
    await expect(new LocalStore(data).load()).rejects.toThrow()
    expect(await readFile(registry, 'utf8')).toBe(text)
  }
})

test('malformed and missing registered logs fail startup', async () => {
  const { cwd, data, store } = await fixture()
  const project = await store.openProject(cwd)
  const log = join(data, 'local', `${project.id}.json`)
  for (const text of ['{', '{}', '[{"text":"partial"}]']) {
    await writeFile(log, text)
    await expect(new LocalStore(data).load()).rejects.toThrow()
  }
  await rm(log)
  await expect(new LocalStore(data).load()).rejects.toThrow()
})

test('project path must be an existing directory and unknown projects cannot write', async () => {
  const { root, store } = await fixture()
  const file = join(root, 'file')
  await writeFile(file, '')
  await expect(store.openProject(file)).rejects.toThrow()
  await expect(store.openProject(join(root, 'absent'))).rejects.toThrow()
  await expect(
    store.append('../bad', { sessionId: 'x', role: 'user', text: 'x' }),
  ).rejects.toThrow()
})
