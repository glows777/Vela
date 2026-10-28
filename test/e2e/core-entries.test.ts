import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

test('core assembly supports memory and schema tools without installing a channel runtime', async () => {
  const core = await import('@glows777/vela-core')
  const { jsonSchema } = await import('ai')
  const model = createFauxModel({
    responses: [
      fauxToolCall('schema_echo', { text: 'public' }),
      fauxText('ok'),
    ],
  })
  const vela = core.createVela({
    model,
    contextFiles: false,
    extensions: [
      core.memory(),
      function schema(api) {
        api.registerTool(
          core.defineJsonSchemaTool({
            name: 'echo',
            description: 'echo',
            inputSchema: jsonSchema({
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            }),
            async execute(input: { text: string }) {
              return input.text
            },
          }),
        )
      },
    ],
  })
  cleanups.push(() => vela.dispose())
  expect('startChannels' in vela).toBe(false)
  await vela.session('core').prompt('echo')
  expect(JSON.stringify(model.calls[1]?.prompt)).toContain('public')
  expect(model.pending()).toBe(0)
})

test('the SDK testing entry and replay use a core-only assembly', async () => {
  const { createTestVela, replayScenario } = await import(
    '@glows777/vela-core/testing'
  )
  const fixture = createTestVela({ responses: [fauxText('core fixture')] })
  cleanups.push(() => fixture.cleanup())
  expect('startChannels' in fixture.vela).toBe(false)
  await fixture.run('offline')
  expect(fixture.lastAssistantText()).toBe('core fixture')
  const path = join(fixture.cwd, 'replay.json')
  writeFileSync(
    path,
    JSON.stringify({ inputs: ['replay'], responses: [{ text: 'replayed' }] }),
  )
  const { t, errors } = await replayScenario(path)
  cleanups.push(() => t.cleanup())
  expect('startChannels' in t.vela).toBe(false)
  expect(errors).toEqual([undefined])
  expect(t.lastAssistantText()).toBe('replayed')
})

test('the public publisher cannot forge agent events; ordinary inspection does not run extension hooks', async () => {
  const core = await import('@glows777/vela-core')
  let previews = 0
  const vela = core.createVela({
    contextFiles: false,
    extensions: [
      function preview(api) {
        api.on('before_agent_start', (event) => {
          previews++
          event.sections.probe = 'preview'
        })
      },
    ],
  })
  cleanups.push(() => vela.dispose())
  const session = vela.session('preview')
  const events: string[] = []
  session.subscribe((event) => {
    events.push(event.type)
  })
  await core.inspectSession(vela, session)
  expect(previews).toBe(0)
  const snapshot = await core.inspectSession(vela, session, {
    previewExtensions: true,
  })
  expect(snapshot.extensionSections.probe).toBe('preview')
  expect(previews).toBe(1)
  core.publishChannelEvent(session, {
    type: 'channel_reply',
    channel: 'fake',
    recipientId: 'owner',
    text: 'reply',
  })
  expect(() =>
    // @ts-expect-error core agent events cannot be published by platforms
    core.publishChannelEvent(session, { type: 'agent_start', input: 'forged' }),
  ).toThrow('Only channel events')
  expect(events).toEqual(['channel_reply'])
})

test('JSON Schema construction requires the SDK wrapper and leaves ordinary schema registration strict', async () => {
  const { defineJsonSchemaTool } = await import(
    '../../packages/core/dist/tools/json-schema.js'
  )
  expect(() =>
    defineJsonSchemaTool({
      name: 'invalid',
      description: 'unwrapped',
      // @ts-expect-error raw JSON Schema is not an AI SDK schema wrapper
      inputSchema: { type: 'object' },
      async execute() {
        return ''
      },
    }),
  ).toThrow('jsonSchema()')
})
