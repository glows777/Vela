import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fileCredentialStore,
  loadModels,
  type ProviderApi,
} from '@glows777/vela-core'
import { setupWizard } from '../../packages/vela/src/cli/tui/setup-wizard.ts'
import { createVela } from '../../packages/vela/src/vela.ts'
import { responsesReply } from '../support/responses.ts'

function reply(api: ProviderApi, body: { model: string; stream?: boolean }) {
  if (api === 'openai-responses') return responsesReply(body)
  if (api === 'openai-completions') {
    const choice = {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'OK' },
    }
    if (!body.stream)
      return Response.json({
        id: 'fake',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [choice],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    return new Response(
      `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
  const message = {
    id: 'fake',
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [{ type: 'text', text: 'OK' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  if (!body.stream) return Response.json(message)
  const events = [
    {
      type: 'message_start',
      message: { ...message, content: [], stop_reason: null },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'OK' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

for (const api of [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
] as const) {
  for (const outcome of [
    'save',
    'cancel',
    'failure',
    'retry',
    'reconfigure',
    'skip',
    'escape',
    'invalid',
  ] as const) {
    test(`custom ${api} setup: ${outcome} verifies before saving and survives restart`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'vela-custom-setup-'))
      const files = ['models.json', 'settings.json', 'auth.json']
      const priorModel = {
        id: 'custom-model',
        name: 'Preserved name',
        maxTokens: 4096,
        reasoning: true,
        thinkingLevelMap: { max: null },
      }
      if (outcome !== 'save') {
        writeFileSync(
          join(dir, files[0]!),
          JSON.stringify({
            note: 'keep',
            providers: {
              custom: {
                api: 'openai-completions',
                baseUrl: 'https://old.invalid/v1',
                headers: { 'x-old': 'keep' },
                models: [priorModel, { id: 'other-model' }],
              },
              unrelated: { api: 'openai-responses', models: [{ id: 'other' }] },
            },
          }),
        )
        writeFileSync(
          join(dir, files[1]!),
          JSON.stringify({
            defaultModel: 'custom/custom-model',
            defaultThinkingLevel: 'high',
            theme: 'dark',
          }),
        )
        writeFileSync(
          join(dir, files[2]!),
          JSON.stringify({
            custom: { type: 'api_key', key: 'old-key' },
            unrelated: { type: 'api_key', key: 'keep' },
          }),
        )
      }
      const snapshot = () =>
        files.map((file) =>
          existsSync(join(dir, file))
            ? readFileSync(join(dir, file), 'utf8')
            : undefined,
        )
      const before = snapshot()
      const options = () => ({
        cwd: dir,
        providers: loadModels({ agentDir: dir, env: {} }),
        credentials: fileCredentialStore(join(dir, 'auth.json')),
      })
      const vela = createVela(options())
      const session = vela.session('initial')
      const requests: {
        url: string
        body: { model: string; stream?: boolean }
        headers: Headers
      }[] = []
      const originalFetch = globalThis.fetch
      let restarted: ReturnType<typeof createVela> | undefined
      let headerAttempts = 0
      let contextAttempts = 0
      globalThis.fetch = (async (input, init) => {
        const body = JSON.parse(String(init?.body))
        requests.push({
          url: String(input),
          body,
          headers: new Headers(init?.headers),
        })
        if (!body.stream) expect(snapshot()).toEqual(before)
        if (
          outcome === 'failure' ||
          (outcome === 'retry' && requests.length === 1)
        )
          return Response.json(
            {
              error: {
                type: 'invalid_request_error',
                message: 'faux rejection',
              },
            },
            { status: 400 },
          )
        return reply(api, body)
      }) as typeof fetch
      try {
        const saved = await setupWizard({
          vela,
          session,
          agentDir: dir,
          select: async (title, choices) => {
            if (title === 'Choose a provider') {
              expect(choices.some((c) => c.value === 'custom')).toBe(true)
              return 'custom'
            }
            if (title === 'API protocol') return api
            if (
              [
                'Custom headers',
                'Model capabilities',
                'Context window',
              ].includes(title)
            )
              return outcome === 'skip' ? 'keep' : 'edit'
            if (title.startsWith('Current model:')) return 'change'
            if (title.startsWith('Credential for')) return 'replace'
            if (title === 'Image input') return 'yes'
            if (title === 'Reasoning support') return 'no'
            if (title === 'Thinking level') {
              if (outcome === 'skip') {
                expect(choices.map((c) => c.value)).not.toContain('max')
                expect(choices.map((c) => c.value)).toContain('high')
              } else expect(choices.map((c) => c.value)).toEqual(['off'])
              return 'off'
            }
            if (title === 'Connect Lark?') return 'later'
            if (title.startsWith('Save configuration')) {
              expect(snapshot()).toEqual(before)
              return outcome === 'cancel' ? 'no' : 'yes'
            }
            if (title.startsWith('Verification failed'))
              return outcome === 'retry' ? 'retry' : 'cancel'
            return 'yes'
          },
          input: async (title, _placeholder, _signal, secret) => {
            if (title === 'Custom headers (JSON, optional)') {
              expect(secret).toBe(true)
              if (outcome === 'escape') return undefined
              if (outcome === 'invalid' && headerAttempts++ < 2)
                return headerAttempts === 1 ? 'not json' : '{"x-test":42}'
            }
            if (
              title === 'Context window (optional)' &&
              outcome === 'invalid' &&
              contextAttempts++ < 2
            )
              return contextAttempts === 1 ? '-1' : 'abc'
            if (title.startsWith('API key')) {
              expect(secret).toBe(true)
              return 'fake-key'
            }
            return (
              {
                'Provider name': 'custom',
                'Base URL': 'https://faux.invalid/v1',
                'Custom headers (JSON, optional)': '{"x-test":"value"}',
                'Model ID': 'custom-model',
                'Context window (optional)': '64000',
              } as Record<string, string>
            )[title]
          },
          pickModel: async () => {
            throw new Error('Custom model should be entered')
          },
          addNotice: () => {},
          setSummary: () => {},
        })
        if (
          outcome === 'cancel' ||
          outcome === 'failure' ||
          outcome === 'escape'
        ) {
          expect(saved).toBe(false)
          expect(snapshot()).toEqual(before)
          return
        }
        expect(saved).toBe(true)
        const config = JSON.parse(
          readFileSync(join(dir, 'models.json'), 'utf8'),
        )
        expect(config.providers.custom).toMatchObject({
          api,
          baseUrl: 'https://faux.invalid/v1',
          headers:
            outcome === 'skip' ? { 'x-old': 'keep' } : { 'x-test': 'value' },
        })
        if (outcome === 'skip')
          expect(config.providers.custom.models[0]).toEqual(priorModel)
        else
          expect(config.providers.custom.models[0]).toMatchObject({
            id: 'custom-model',
            contextWindow: 64000,
            input: ['text', 'image'],
            reasoning: false,
          })
        if (outcome !== 'save') {
          expect(config.note).toBe('keep')
          expect(config.providers.custom.models[0]).toMatchObject({
            name: 'Preserved name',
            maxTokens: 4096,
            thinkingLevelMap: { max: null },
          })
          expect(config.providers.custom.models[1]).toEqual({
            id: 'other-model',
          })
          expect(config.providers.unrelated.models).toEqual([{ id: 'other' }])
          expect(
            JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).theme,
          ).toBe('dark')
        }
        expect(session.modelInfo.ref).toBe('custom/custom-model')
        expect(session.thinkingLevel).toBe('off')
        await session.prompt('Hello')
        restarted = createVela(options())
        const next = restarted.session('restart', {
          model: 'custom/custom-model',
          thinkingLevel: 'off',
        })
        await next.prompt('Hello again')
        expect(JSON.stringify(next.messages)).toContain('OK')
        expect(requests).toHaveLength(outcome === 'retry' ? 4 : 3)
        for (const request of requests) {
          expect(request.url).toBe(
            `https://faux.invalid/v1/${api === 'anthropic-messages' ? 'messages' : api === 'openai-responses' ? 'responses' : 'chat/completions'}`,
          )
          expect(request.body.model).toBe('custom-model')
          expect(
            request.headers.get(outcome === 'skip' ? 'x-old' : 'x-test'),
          ).toBe(outcome === 'skip' ? 'keep' : 'value')
          expect(
            request.headers.get(
              api === 'anthropic-messages' ? 'x-api-key' : 'authorization',
            ),
          ).toBe(api === 'anthropic-messages' ? 'fake-key' : 'Bearer fake-key')
        }
      } finally {
        globalThis.fetch = originalFetch
        await vela.dispose()
        await restarted?.dispose()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
}
