import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { channelSessionId } from '../../src/channels/session-id.ts'
import { feishu } from '../../src/extensions/feishu/index.ts'
import type { VelaExtension } from '../../src/extensions/types.ts'
import {
  type FauxStep,
  fauxText,
  fauxToolCall,
} from '../../src/testing/faux.ts'
import { fakeFeishu, feishuEvent } from '../support/feishu.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

async function until(check: () => boolean) {
  const deadline = Date.now() + 2500
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('Group workspace run did not finish')
    await Bun.sleep(1)
  }
}

function setup(
  chats: unknown = ['oc_alpha', 'oc_beta'],
  cwd?: string,
  extensions: VelaExtension[] = [],
) {
  const fake = fakeFeishu()
  const t = createTestVela({
    cwd,
    allowPendingResponses: true,
    extensionConfig: { feishu: { chats } },
    extensions: [
      feishu({ transport: fake.transport, owners: ['ou_alice'] }),
      ...extensions,
    ],
  })
  return { t, fake }
}

async function turn(
  run: ReturnType<typeof setup>,
  chat: string,
  root: string | undefined,
  text: string,
  steps: FauxStep[],
) {
  run.t.model.push(...steps)
  const count = run.fake.sent.length
  run.fake.deliver(
    feishuEvent({
      chat_id: chat,
      ...(root ? { root_id: root, thread_id: `thread_${root}` } : {}),
      content: JSON.stringify({ text }),
    }),
  )
  await until(() => run.fake.sent.length > count)
}

const save = (value: string) =>
  fauxToolCall('memory', {
    action: 'save',
    name: 'shared-name',
    description: `${value} note`,
    type: 'project',
    content: value,
  })

test('two groups keep same-name files and memory separate across topics, idle reopen, restart and a fresh Vela', async () => {
  const run = setup()
  const { t } = run
  t.model.push(
    fauxToolCall('memory', {
      action: 'save',
      name: 'global-guide',
      description: 'Shared global guidance',
      type: 'reference',
      content: 'GLOBAL guidance',
    }),
    fauxText('saved global'),
  )
  await t.run('Save global guidance')
  const files = t.dataPath(
    `channels/${channelSessionId('feishu', 'oc_alpha')}/files`,
  )
  mkdirSync(files, { recursive: true })
  writeFileSync(join(files, 'existing.txt'), 'retained attachment')
  await t.vela.startChannels()
  for (const [chat, value] of [
    ['oc_alpha', 'ALPHA'],
    ['oc_beta', 'BETA'],
  ] as const) {
    await turn(run, chat!, 'root', 'Save this group note and file', [
      save(value!),
      fauxToolCall('write_file', { path: 'same.txt', content: value }),
      fauxText('saved'),
    ])
    const folder = `channels/${channelSessionId('feishu', chat!)}`
    expect(await t.readData(`${folder}/workspace/same.txt`)).toBe(value)
    expect(
      await t.readData(`${folder}/memory/project_shared-name.md`),
    ).toContain(value!)
  }
  expect(existsSync(join(t.cwd, 'same.txt'))).toBe(false)
  expect(existsSync(t.dataPath('memory/project_shared-name.md'))).toBe(false)

  async function verify(
    current: ReturnType<typeof setup>,
    chat: string,
    value: string,
    root = 'root',
  ) {
    const other = value === 'ALPHA' ? 'BETA' : 'ALPHA'
    await turn(current, chat, root, 'Read our saved work and shared guidance', [
      (req) => {
        expect(req.system).toContain(`${value} note`)
        expect(req.system).not.toContain(`${other} note`)
        expect(req.system).toContain('Shared global guidance')
        expect(req.system).toContain(
          current.t.dataPath(
            `channels/${channelSessionId('feishu', chat)}/workspace`,
          ),
        )
        return fauxToolCall('memory', {
          action: 'read',
          filename: 'project_shared-name.md',
        })
      },
      (req) => {
        expect(req.toolResults.at(-1)?.output).toContain(value)
        expect(req.toolResults.at(-1)?.output).not.toContain(other)
        return fauxToolCall('read_file', { path: 'same.txt' })
      },
      (req) => {
        expect(req.toolResults.at(-1)?.output).toBe(value)
        return fauxToolCall('memory', {
          action: 'search',
          query: `${other} note`,
        })
      },
      (req) => {
        expect(req.toolResults.at(-1)?.output).not.toContain(`${other} note`)
        return fauxToolCall('memory', {
          action: 'read',
          scope: 'global',
          filename: 'reference_global-guide.md',
        })
      },
      (req) => {
        expect(req.toolResults.at(-1)?.output).toContain('GLOBAL guidance')
        return fauxToolCall('memory', {
          action: 'delete',
          scope: 'global',
          filename: 'reference_global-guide.md',
        })
      },
      (req) => {
        expect(req.toolResults.at(-1)?.output).toMatch(
          /global.*read.only|read.only.*global/i,
        )
        return fauxText('verified')
      },
    ])
    expect(current.fake.sent.at(-1)?.text).toContain('verified')
  }
  await verify(run, 'oc_alpha', 'ALPHA', 'second-root')
  await t.vela.session(channelSessionId('feishu', 'oc_beta', 'root')).close()
  await verify(run, 'oc_beta', 'BETA')
  await turn(run, 'oc_alpha', 'root', '!restart', [])
  expect(run.fake.sent.at(-1)?.text).toContain('Restarted with a fresh session')
  await verify(run, 'oc_alpha', 'ALPHA')
  await t.vela.dispose()
  const again = setup(undefined, t.cwd)
  await again.t.vela.startChannels()
  await verify(again, 'oc_alpha', 'ALPHA')
  await verify(again, 'oc_beta', 'BETA')
  expect(readFileSync(join(files, 'existing.txt'), 'utf8')).toBe(
    'retained attachment',
  )
  expect(await again.t.readData('memory/reference_global-guide.md')).toContain(
    'GLOBAL guidance',
  )
  await again.t.vela.dispose()
})

test('unknown group tools reject startup before transport connects, after asynchronous extensions finish loading', async () => {
  const { t, fake } = setup(
    [{ id: 'oc_alpha', tools: ['late_tool', 'missing_tool'] }],
    undefined,
    [
      async function late(api) {
        await Promise.resolve()
        api.registerTool({
          name: 'tool',
          description: 'Async fixture',
          inputSchema: z.object({}),
          execute: async () => 'ok',
        })
      },
    ],
  )
  let connected = false
  const start = fake.transport.start
  fake.transport.start = async (...args) => {
    connected = true
    await start(...args)
  }
  await expect(t.vela.startChannels()).rejects.toThrow('missing_tool')
  expect(connected).toBe(false)
})

test.each([
  { chats: [{ id: 'oc_alpha', tools: 'read_file' }] },
  { chats: ['oc_alpha', { id: 'oc_alpha' }] },
  { chats: [{ id: 'oc_alpha', readUntagged: 'yes' }] },
])('malformed group configuration fails loading: %j', async ({ chats }) => {
  await expect(async () => {
    const { t } = setup(chats)
    await t.vela.ready()
  }).toThrow()
})

test('an empty tool list retains channel controls, hides memory and cannot invoke a removed file tool after restart', async () => {
  const run = setup([{ id: 'oc_alpha', tools: [] }])
  await run.t.vela.startChannels()
  await turn(run, 'oc_alpha', undefined, 'A short answer', [
    (req) => {
      expect(req.tools).toEqual(
        expect.arrayContaining([
          'feishu_start_topic',
          'feishu_forward_to_topic',
          'feishu_list_topics',
        ]),
      )
      expect(req.tools).not.toContain('memory')
      expect(req.system).not.toContain('[memory]')
      return fauxText('short')
    },
  ])
  for (const restart of [false, true]) {
    if (restart) await turn(run, 'oc_alpha', 'root', '!restart', [])
    await turn(run, 'oc_alpha', 'root', 'Try a removed tool', [
      fauxToolCall('write_file', { path: 'forbidden.txt', content: 'NO' }),
      fauxText('denied'),
    ])
    const events = run.t.eventsOf('tool_execution_end')
    expect(JSON.stringify(events.at(-1))).toMatch(
      /denied|unavailable|not available|not found|not allowed/i,
    )
    expect(
      existsSync(
        run.t.dataPath('channels/feishu-oc_alpha/workspace/forbidden.txt'),
      ),
    ).toBe(false)
    expect(existsSync(join(run.t.cwd, 'forbidden.txt'))).toBe(false)
  }
})
