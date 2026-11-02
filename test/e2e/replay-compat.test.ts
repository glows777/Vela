import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupTestVelas,
  replayScenario,
  tempDir,
} from '@glows777/vela/testing'

afterEach(cleanupTestVelas)

test('umbrella replay retains its channel assembly and optional RAG fixture', async () => {
  const dir = tempDir('vela-replay-compat-')
  try {
    const path = join(dir.path, 'scenario.json')
    writeFileSync(
      path,
      JSON.stringify({
        inputs: ['Ingest the guide'],
        responses: [
          {
            toolCalls: [{ name: 'rag_ingest', input: { path: 'guide.md' } }],
          },
          { text: 'Guide ingested' },
        ],
      }),
    )
    const { t, errors } = await replayScenario(path, {
      embedder: true,
      files: { 'guide.md': 'Use blue-green deployments for the service.' },
    })
    expect(errors).toEqual([undefined])
    expect(typeof t.vela.startChannels).toBe('function')
    expect(t.eventsOf('tool_execution_end')[0]).toMatchObject({
      toolName: 'rag_ingest',
      isError: false,
    })
    expect(t.exists('rag/knowledge.db')).toBe(true)
    expect(t.lastAssistantText()).toBe('Guide ingested')
  } finally {
    dir.cleanup()
  }
})
