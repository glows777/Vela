import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export interface DockerOptions {
  dataDir: string
  name: string
  image: string
  network?: 'on' | 'off'
}
const hash = (fields: unknown[]) =>
  createHash('sha256').update(JSON.stringify(fields)).digest('hex')

// The workspace is allocated under the trusted owner data directory. There is no caller-supplied bind source.
export async function prepareDocker(
  o: DockerOptions,
  run: (args: string[]) => Promise<string>,
) {
  if (
    process.platform !== 'linux' ||
    !process.getuid?.() ||
    !process.getgid?.()
  )
    throw Error('Docker requires a non-root Linux host uid:gid')
  if (
    typeof o.image !== 'string' ||
    !o.image.trim() ||
    o.image.startsWith('-') ||
    /\s/u.test(o.image) ||
    o.image.includes('\0')
  )
    throw Error('A Docker image is required')
  if (o.network !== undefined && o.network !== 'off' && o.network !== 'on')
    throw Error('Invalid Docker network mode')
  if (!o.name?.trim() || !isAbsolute(o.dataDir))
    throw Error(
      'A named environment and absolute owner data directory are required',
    )
  if (
    Object.keys(o).some(
      (key) => !['dataDir', 'name', 'image', 'network'].includes(key),
    )
  )
    throw Error('Unsupported Docker environment option')
  await mkdir(o.dataDir, { recursive: true, mode: 0o700 })
  const data = await realpath(o.dataDir)
  const owner = hash([data, o.name])
  const name = `vela-${owner.slice(0, 32)}`
  let workspace = data
  for (const part of ['environments', owner, 'workspace']) {
    workspace = join(workspace, part)
    try {
      await mkdir(workspace, { mode: 0o700 })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    if (!(await lstat(workspace)).isDirectory())
      throw Error('Invalid Docker workspace directory')
  }
  if (/[,"\n\r]/u.test(workspace)) throw Error('Unsupported Docker mount path')
  const user = `${process.getuid()}:${process.getgid()}`
  const network = o.network === 'off' ? 'none' : 'bridge'
  const config = hash([workspace, o.image, user, network])
  const ownerKey = 'org.vela.environment'
  const configKey = 'org.vela.configuration'
  const lookup = () =>
    run([
      'ps',
      '-aq',
      '--no-trunc',
      '--filter',
      `name=^/${name}$`,
      '--filter',
      `label=${ownerKey}=${owner}`,
    ])
  let id = await lookup()
  if (!id) {
    try {
      id = await run([
        'create',
        '--pull=never',
        '--init',
        '--name',
        name,
        '--label',
        `${ownerKey}=${owner}`,
        '--label',
        `${configKey}=${config}`,
        '--user',
        user,
        '--network',
        network,
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--mount',
        `type=bind,src=${workspace},dst=/workspace`,
        '--workdir',
        '/workspace',
        '--env',
        'HOME=/tmp/vela-home',
        '--env',
        'TMPDIR=/tmp',
        '--entrypoint',
        'sleep',
        o.image,
        'infinity',
      ])
    } catch (e) {
      // Another process might have prepared the same named container. Inspect its identity before use.
      id = await lookup()
      if (!id) throw e
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(id))
    throw Error('Ambiguous Docker container identity')
  const [object] = JSON.parse(await run(['inspect', '--type', 'container', id]))
  const mount = object?.Mounts?.[0]
  if (
    object?.Id !== id ||
    object.Config?.Labels?.[ownerKey] !== owner ||
    object.Config.Labels[configKey] !== config ||
    object.Config.User !== user ||
    object.Config.Image !== o.image ||
    object.HostConfig?.NetworkMode !== network ||
    object.HostConfig.Privileged !== false ||
    object.Mounts.length !== 1 ||
    mount.Type !== 'bind' ||
    mount.Source !== workspace ||
    mount.Destination !== '/workspace' ||
    !mount.RW
  )
    throw Error(
      'Docker container ownership or configuration differs; explicit owner restart required',
    )
  if (!object.State.Running) await run(['start', id])
  const missingTools = await run([
    'exec',
    '--workdir',
    '/workspace',
    id,
    'node',
    '-e',
    `
      const {spawnSync} = require('node:child_process')
      const missing = ['rg','fd'].filter(tool =>
        spawnSync(tool,['--version'], {stdio:'ignore'}).status !== 0)
      if (missing.length) {
        console.log(missing.join(', '))
      } else {
        require('node:fs').mkdirSync(process.env.HOME, {recursive:true,mode:0o700})
      }
    `,
  ])
  if (missingTools) {
    if (!object.State.Running) await run(['stop', '--timeout', '1', id])
    throw Error(`Missing required Docker tools: ${missingTools}`)
  }
  return { id, name }
}
