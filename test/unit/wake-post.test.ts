import { expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

const workflow = parse(
  await Bun.file('.github/workflows/wake-route.yml').text(),
)
const postScript = workflow.jobs.wake.steps.find(
  (step: { id?: string }) => step.id === 'post',
).run as string

async function post(options: {
  status?: number
  body?: string
  grok?: boolean
  state?: Record<string, number>
}) {
  const dir = await mkdtemp(join(tmpdir(), 'wake-post-'))
  const requests: Array<{
    path: string
    authorization: string | null
    body: Record<string, unknown>
  }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      requests.push({
        path,
        authorization: request.headers.get('authorization'),
        body: (await request.json()) as Record<string, unknown>,
      })
      return new Response('{}', { status: options.status ?? 200 })
    },
  })
  try {
    await mkdir(join(dir, '.github/wake'), { recursive: true })
    await copyFile(
      '.github/wake/decide.mjs',
      join(dir, '.github/wake/decide.mjs'),
    )
    await Bun.write(
      join(dir, 'event.json'),
      JSON.stringify({
        action: 'created',
        repository: { full_name: 'acme/vela' },
        sender: { login: 'liam' },
        issue: {
          number: 1284,
          title: 'Debounce wake posts',
          html_url: 'https://github.com/acme/vela/issues/1284',
          labels: [],
          state: 'open',
          updated_at: '2026-10-26T15:04:05Z',
        },
        comment: {
          id: 555,
          body: options.body ?? '@forge',
          created_at: '2026-10-26T15:04:05Z',
        },
      }),
    )
    const statePath = join(dir, '.wake-state/buckets.json')
    if (options.state) {
      await mkdir(join(dir, '.wake-state'))
      await Bun.write(statePath, JSON.stringify(options.state))
    }
    const outputPath = join(dir, 'output')
    await Bun.write(outputPath, '')
    // Run the actual Actions post step with only local endpoints and a fake key.
    const child = Bun.spawn(['bash', '-c', postScript], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: outputPath,
        WAKE_EVENT_NAME: 'issue_comment',
        WAKE_EVENT_PATH: join(dir, 'event.json'),
        WAKE_STATE_PATH: statePath,
        WAKE_GROK_FORGE_WEBHOOK_URL: options.grok ? `${server.url}grok` : '',
        WAKE_GROK_FORGE_WEBHOOK_KEY: options.grok ? 'local-test-key' : '',
        WAKE_FORK: 'false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return {
      status,
      stdout,
      stderr,
      requests,
      output: await Bun.file(outputPath).text(),
      state: (await Bun.file(statePath).exists())
        ? ((await Bun.file(statePath).json()) as Record<string, number>)
        : undefined,
    }
  } finally {
    await server.stop(true)
    await rm(dir, { recursive: true, force: true })
  }
}

test('Grok HTTP failure fails without saving a bucket', async () => {
  const result = await post({ status: 500, grok: true, state: { taste: 1 } })
  expect(result.status).not.toBe(0)
  expect(result.requests).toHaveLength(1)
  expect(result.output).toBe('')
  expect(result.state).toEqual({ taste: 1 })
})

test('missing Grok secret skips without requests or saved buckets', async () => {
  const result = await post({ body: '@forge Taste', grok: false })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('missing secret for sink grok')
  expect(result.requests).toEqual([])
  expect(result.output).toBe('')
  expect(result.state).toBeUndefined()
})

test('Forge and Taste post authorized route bodies to Grok', async () => {
  const result = await post({ body: '@forge Taste', grok: true })
  expect(result.status).toBe(0)
  expect(result.output).toBe('save=true\n')
  expect(Object.keys(result.state ?? {})).toEqual(['forge', 'taste'])
  expect(
    result.requests.map((request) => ({
      path: request.path,
      authorization: request.authorization,
      route: request.body.route,
    })),
  ).toEqual([
    { path: '/grok', authorization: 'Bearer local-test-key', route: 'forge' },
    { path: '/grok', authorization: 'Bearer local-test-key', route: 'taste' },
  ])
})
