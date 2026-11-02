import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  CHANNEL_DOC_ALLOWLIST,
  channelToolsInSource,
  checkChannelDocs,
  exposedToolName,
  missingChannelTools,
} from '../../scripts/check-channel-docs.ts'

const ROOT = resolve(import.meta.dir, '../..')
const HINT =
  'Document it in docs/channels.md in the same change as the CHANGELOG entry, or add the exposed name to CHANNEL_DOC_ALLOWLIST when a person or model cannot see it.'

describe('channel guide', () => {
  test('prefixes a registered name with the extension name', () => {
    expect(exposedToolName('channel', 'message_topic')).toBe(
      'channel_message_topic',
    )
    expect(exposedToolName('lark', 'lark_routines')).toBe('lark_routines')
    expect(exposedToolName('channel', 'channel')).toBe('channel')
  })

  test('fails when a registered name is missing from the guide', () => {
    const refs = channelToolsInSource(
      'packages/channels/src/handoff.ts',
      "api.registerTool({ name: 'message_topic' })",
      'channel',
    )
    expect(missingChannelTools(refs, 'lark_start_topic_extra')).toEqual([
      'channel_message_topic (packages/channels/src/handoff.ts:1) is not in docs/channels.md',
      HINT,
    ])
    const present = channelToolsInSource(
      'packages/lark/src/topics.ts',
      "vela.registerTool({ name: 'start_topic' })\nvela.registerTool({ name: 'skip_reply' })",
      'lark',
    )
    expect(
      missingChannelTools(
        present,
        'call lark_start_topic here',
        new Set(['lark_skip_reply']),
      ),
    ).toEqual([])
  })

  test('ignores a registerTool that is only a comment or a string', () => {
    const text = `// api.registerTool({ name: 'gone' })
const note = 'api.registerTool({ name: "also_gone" })'
api.registerTool({ name: 'start_topic' })
`
    expect(
      channelToolsInSource('packages/lark/src/topics.ts', text, 'lark').map(
        (ref) => ref.name,
      ),
    ).toEqual(['lark_start_topic'])
  })

  test('rejects a registerTool call whose name the check cannot see', () => {
    expect(() =>
      channelToolsInSource(
        'packages/lark/src/topics.ts',
        'api.registerTool({ name: toolName })',
        'lark',
      ),
    ).toThrow('string literal')
    expect(() =>
      channelToolsInSource(
        'packages/lark/src/topics.ts',
        'api.registerTool(tool)',
        'lark',
      ),
    ).toThrow('object literal')
  })

  test('the allowlist starts empty and the tree matches the guide', async () => {
    expect(CHANNEL_DOC_ALLOWLIST.size).toBe(0)
    expect(await checkChannelDocs(ROOT)).toEqual([])
  })
})
