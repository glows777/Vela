import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export interface DockerOptions {
  dataDir: string
  name: string
  image: string
  network?: 'on' | 'off' | 'restricted'
  allow?: readonly string[]
}
const hash = (fields: unknown[]) =>
  createHash('sha256').update(JSON.stringify(fields)).digest('hex')

function validateImage(image: string) {
  if (
    typeof image !== 'string' ||
    !image.trim() ||
    image.startsWith('-') ||
    /\s/u.test(image) ||
    image.includes('\0')
  )
    throw Error('A Docker image is required')
}

export const restrictedGuestDir = '/vela-egress'

export async function restrictedDirectory(
  o: DockerOptions,
  allow: readonly string[],
) {
  if (
    process.platform !== 'linux' ||
    !process.getuid?.() ||
    !process.getgid?.()
  )
    throw Error('Docker restricted networking requires a non-root Linux host')
  if (!o.name?.trim() || !isAbsolute(o.dataDir))
    throw Error(
      'A named environment and absolute owner data directory are required',
    )
  validateImage(o.image)
  await mkdir(o.dataDir, { recursive: true, mode: 0o700 })
  const directory = join(
    '/tmp',
    `vela-egress-${hash([await realpath(o.dataDir), o.name, o.image, allow]).slice(0, 32)}`,
  )
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const entry = await lstat(directory)
  if (
    !entry.isDirectory() ||
    entry.uid !== process.getuid() ||
    (entry.mode & 0o777) !== 0o700
  )
    throw Error('Docker restricted proxy directory is not owner-private')
  return directory
}

// The workspace is allocated under the trusted owner data directory. There is no caller-supplied bind source.
export async function prepareDocker(
  o: DockerOptions,
  run: (args: string[]) => Promise<string>,
  restricted?: { directory: string; socket: string },
) {
  if (
    (process.platform !== 'linux' && process.platform !== 'darwin') ||
    !process.getuid?.() ||
    !process.getgid?.()
  )
    throw Error('Docker requires a non-root Linux or macOS host uid:gid')
  validateImage(o.image)
  if (
    o.network !== undefined &&
    o.network !== 'off' &&
    o.network !== 'on' &&
    o.network !== 'restricted'
  )
    throw Error('Invalid Docker network mode')
  if (
    (o.network === 'restricted') !== Boolean(restricted) ||
    (restricted && process.platform !== 'linux')
  )
    throw Error(
      'Docker restricted networking requires the Linux proxy transport',
    )
  if (!o.name?.trim() || !isAbsolute(o.dataDir))
    throw Error(
      'A named environment and absolute owner data directory are required',
    )
  if (
    Object.keys(o).some(
      (key) => !['dataDir', 'name', 'image', 'network', 'allow'].includes(key),
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
  const network = o.network === 'off' || restricted ? 'none' : 'bridge'
  const config = hash([
    workspace,
    o.image,
    user,
    network,
    ...(restricted ? ['restricted-v1', restricted.directory, o.allow] : []),
  ])
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
  let created = false
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
        ...(restricted
          ? [
              '--mount',
              `type=bind,src=${restricted.directory},dst=${restrictedGuestDir},readonly`,
            ]
          : []),
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
      created = true
    } catch (e) {
      // Another process might have prepared the same named container. Inspect its identity before use.
      id = await lookup()
      if (!id) throw e
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(id))
    throw Error('Ambiguous Docker container identity')
  let restoreStopped = false
  try {
    const [object] = JSON.parse(
      await run(['inspect', '--type', 'container', id]),
    )
    const mounts: {
      Type: string
      Source: string
      Destination: string
      RW: boolean
    }[] = object?.Mounts ?? []
    const mount = mounts.find((item) => item.Destination === '/workspace')
    const proxyMount = mounts.find(
      (item) => item.Destination === restrictedGuestDir,
    )
    if (
      object?.Id !== id ||
      object.Config?.Labels?.[ownerKey] !== owner ||
      object.Config.Labels[configKey] !== config ||
      object.Config.User !== user ||
      object.Config.Image !== o.image ||
      object.HostConfig?.NetworkMode !== network ||
      object.HostConfig.Privileged !== false ||
      mounts.length !== (restricted ? 2 : 1) ||
      mount?.Type !== 'bind' ||
      mount.Source !== workspace ||
      mount.RW !== true ||
      (restricted &&
        (proxyMount?.Type !== 'bind' ||
          proxyMount.Source !== restricted.directory ||
          proxyMount.RW !== false))
    )
      throw Error(
        'Docker container ownership or configuration differs; explicit owner restart required',
      )
    if (!object.State.Running) {
      restoreStopped = true
      await run(['start', id])
    }
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
    if (missingTools)
      throw Error(`Missing required Docker tools: ${missingTools}`)
    if (restricted) {
      await run([
        'exec',
        id,
        'node',
        '-e',
        `
          const interfaces = Object.keys(require('node:os').networkInterfaces())
          if (interfaces.length !== 1 || interfaces[0] !== 'lo')
            throw Error('Docker guest network is not loopback-only')
          const socket = require('node:net').connect(process.argv[1])
          socket.setTimeout(3000, () => socket.destroy(Error('Restricted proxy is unavailable')))
          socket.once('connect', () => socket.end())
        `,
        '--',
        restricted.socket,
      ])
    }
  } catch (cause) {
    try {
      if (created) await run(['rm', '-fv', id])
      else if (restoreStopped) await run(['stop', '--timeout', '1', id])
    } catch (rollbackError) {
      throw new AggregateError(
        [cause, rollbackError],
        `${cause} (Docker rollback failed: ${rollbackError})`,
        { cause },
      )
    }
    throw cause
  }
  return { id, name }
}
