import { afterAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  freeLocalPort,
  LOCAL_TOKEN,
  LocalClient,
  type Project,
  type Snapshot,
  sessionPath,
  until,
  type VisibleMessage,
  watchLocal,
} from '../support/local.ts'
import { tempDir } from '../support/vela.ts'

const ROOT = resolve(import.meta.dir, '../..')
const dirs: { cleanup(): void }[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) dir.cleanup()
})

test('real serve admits project chat, starts a file task and delivers HTTP/SSE without leaking hidden model data', async () => {
  const cwd = tempDir('vela-local-serve-')
  const home = tempDir('vela-local-home-')
  const projectDir = tempDir('vela-local-opened-project-')
  dirs.push(cwd, home, projectDir)
  const port = await freeLocalPort()
  await Bun.write(
    join(home.path, 'settings.json'),
    JSON.stringify({
      extensionConfig: {
        local: { enabled: true, token: '$VELA_LOCAL_TOKEN', port },
      },
    }),
  )
  // Opening this directory must not load executable configuration or change the
  // daemon's model/listener. Only its working directory and context are selected.
  const marker = join(projectDir.path, 'extension-executed')
  await Bun.write(
    join(projectDir.path, '.vela/settings.json'),
    JSON.stringify({
      defaultModel: 'unknown-project-provider/invalid-model',
      extensionConfig: {
        local: { enabled: false, token: 'project-must-not-override', port: 1 },
      },
    }),
  )
  await Bun.write(
    join(projectDir.path, '.vela/extensions/marker.ts'),
    `
    import { writeFileSync } from 'node:fs'
    writeFileSync(${JSON.stringify(marker)}, 'loaded')
    export default () => {}
  `,
  )
  // After the handoff, both task and hub can ask for a model response. An identical
  // write request is harmless in either slot; the hub has been silenced by handoff.
  await Bun.write(
    join(cwd.path, 'scenario.json'),
    JSON.stringify({
      responses: [
        {
          toolCalls: [
            {
              name: 'channel_start_topic',
              input: {
                title: 'Create local file',
                brief: 'Write local-result.txt in the selected project',
              },
            },
          ],
        },
        ...Array.from({ length: 2 }, () => ({
          reasoning: 'HIDDEN_LOCAL_REASONING',
          toolCalls: [
            {
              name: 'write_file',
              input: {
                path: 'local-result.txt',
                content: 'PRIVATE_FILE_CONTENT',
              },
            },
          ],
        })),
        ...Array.from({ length: 4 }, () => ({ text: 'Local file created' })),
      ],
    }),
  )
  const proc = Bun.spawn(
    ['bun', join(ROOT, 'packages/vela/src/cli/main.ts'), 'serve'],
    {
      cwd: cwd.path,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home.path,
        VELA_DIR: home.path,
        VELA_MODEL: `faux:${join(cwd.path, 'scenario.json')}`,
        VELA_LOCAL_TOKEN: LOCAL_TOKEN,
        VELA_OFFLINE: '1',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  let stderr = ''
  const reading = (async () => {
    for await (const chunk of proc.stderr)
      stderr += new TextDecoder().decode(chunk)
  })()
  const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000)
  let watch: Awaited<ReturnType<typeof watchLocal>> | undefined
  try {
    const client = new LocalClient(`http://127.0.0.1:${port}`, LOCAL_TOKEN)
    await until(async () => {
      try {
        await client.request('/v1/info')
        return true
      } catch {
        return false
      }
    }, `serve startup: ${stderr}`)
    const project = await client.request<Project>('/v1/projects', {
      cwd: projectDir.path,
    })
    expect(project.cwd).toBe(projectDir.path)
    watch = await watchLocal(client, project.id)
    await client.request(`${sessionPath(project)}/messages`, {
      text: 'Create the local file',
    })
    await until(
      () => watch!.events.some((event) => event.event === 'status'),
      'serve task completion',
    )
    const sessions = (
      await client.request<{ sessions: Snapshot[] }>(
        `/v1/projects/${project.id}/sessions`,
      )
    ).sessions
    const task = sessions.find((session) => session.topic)!
    expect(task).toBeDefined()
    const history = await client.request<{ messages: VisibleMessage[] }>(
      `${sessionPath(project, task.sessionId)}/messages`,
    )
    expect(
      history.messages.some((message) => message.text === 'Local file created'),
    ).toBe(true)
    expect(
      readFileSync(join(projectDir.path, 'local-result.txt'), 'utf8'),
    ).toBe('PRIVATE_FILE_CONTENT')
    expect(existsSync(join(cwd.path, 'local-result.txt'))).toBe(false)
    expect(existsSync(marker)).toBe(false)
    const visible = JSON.stringify([watch.events, history])
    expect(visible).not.toContain('HIDDEN_LOCAL_REASONING')
    expect(visible).not.toContain('PRIVATE_FILE_CONTENT')
    expect(visible).not.toContain(LOCAL_TOKEN)
    const example = Bun.spawn(
      [
        'bun',
        join(ROOT, 'examples/local-client.ts'),
        projectDir.path,
        'Report status',
      ],
      {
        cwd: cwd.path,
        env: {
          PATH: process.env.PATH ?? '',
          VELA_LOCAL_TOKEN: LOCAL_TOKEN,
          VELA_LOCAL_URL: client.url,
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const exampleTimer = setTimeout(() => example.kill('SIGKILL'), 5000)
    try {
      const output = await new Response(example.stdout).text()
      const errors = await new Response(example.stderr).text()
      expect(await example.exited).toBe(0)
      expect(errors).toBe('')
      expect(output).toContain('run_finished')
      expect(output).toContain('Local file created')
      expect(output).not.toContain(LOCAL_TOKEN)
    } finally {
      clearTimeout(exampleTimer)
      example.kill('SIGTERM')
      await example.exited
    }
    await watch.close()
    watch = undefined
    // Keep an authenticated SSE fetch live while the daemon is stopped. Both a
    // clean EOF and a socket-close error are valid transport shutdown signals.
    const shutdownStream = client.events(`/v1/events?projectId=${project.id}`)
    expect((await shutdownStream.next()).value?.event).toBe('reset')
    const disconnected = shutdownStream.next().then(
      (result) => result.done === true,
      () => true,
    )
    proc.kill('SIGTERM')
    expect(await proc.exited).toBe(0)
    let shutdownTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      expect(
        await Promise.race([
          disconnected,
          new Promise<boolean>((done) => {
            shutdownTimeout = setTimeout(() => done(false), 3000)
          }),
        ]),
      ).toBe(true)
    } finally {
      clearTimeout(shutdownTimeout)
    }
    await shutdownStream.return(undefined)
    expect(existsSync(marker)).toBe(false)
    await reading
    expect(stderr).not.toContain(LOCAL_TOKEN)
  } finally {
    await watch?.close()
    proc.kill('SIGTERM')
    await proc.exited
    clearTimeout(timer)
    await reading
  }
}, 30_000)
