// Opt in with an owner-provided local image containing node, bash, rg and fd. Never pulls.
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tempDir } from '@glows777/vela/testing'
import type { ExecutionEnv } from '@glows777/vela-core'
import { buildDockerAdapter } from '../../extensions/docker/build.ts'
import { runDocker } from '../../extensions/docker/container.ts'
import { checkDockerOperations } from '../support/docker-conformance.ts'

const image = process.env.VELA_TEST_DOCKER_IMAGE
test.skipIf(!image)(
  'prepared Docker image runs the built adapter, survives reopen and isolates environments',
  async () => {
    const dir = tempDir('vela-image-')
    const owners = new Set<string>()
    const adapters: ExecutionEnv[] = []
    try {
      await buildDockerAdapter(dir.path)
      const { openDockerEnvironment } = await import(
        join(dir.path, 'adapter.mjs')
      )
      async function open(name: string): Promise<ExecutionEnv> {
        owners.add(
          createHash('sha256')
            .update(JSON.stringify([dir.path, name]))
            .digest('hex'),
        )
        const env = await openDockerEnvironment({
          dataDir: dir.path,
          name,
          image,
          network: 'off',
        })
        adapters.push(env)
        return env
      }
      const a = await open('alpha')
      await checkDockerOperations(a)
      const reopened = await open('alpha')
      expect(await reopened.readTextFile('page')).toEqual({
        ok: true,
        value: 'replaced',
      })
      const b = await open('beta')
      expect(b.id).not.toBe(a.id)
      expect(await b.exists('page')).toEqual({ ok: true, value: false })
    } finally {
      try {
        await Promise.all(adapters.map((env) => env.cleanup()))
      } finally {
        for (const key of owners) {
          const id = await runDocker([
            'ps',
            '-aq',
            '--no-trunc',
            '--filter',
            `label=org.vela.environment=${key}`,
          ])
          if (/^[a-f0-9]{64}$/.test(id)) await runDocker(['rm', '-fv', id])
        }
        dir.cleanup()
      }
    }
  },
  240000,
)
