import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// Inputs are the validated, normalized DNS names of the owner's credential
// origins. Only the bridge's public CA is sent to the guest.
export async function createCredentialIdentity(hosts: readonly string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'vela-credential-tls-'))
  try {
    const caExt = join(dir, 'ca.cnf')
    const leafExt = join(dir, 'leaf.cnf')
    const caKey = join(dir, 'ca.key')
    const caCert = join(dir, 'ca.pem')
    const leafKey = join(dir, 'leaf.key')
    const leafRequest = join(dir, 'leaf.csr')
    const leafCert = join(dir, 'leaf.pem')
    await writeFile(
      caExt,
      [
        '[req]',
        'distinguished_name=dn',
        'x509_extensions=ca',
        '[dn]',
        '[ca]',
        'basicConstraints=critical,CA:TRUE,pathlen:0',
        'keyUsage=critical,keyCertSign',
      ].join('\n'),
    )
    await writeFile(
      leafExt,
      [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature',
        'extendedKeyUsage=serverAuth',
        `subjectAltName=${hosts.map((name) => `DNS:${name}`).join(',')}`,
      ].join('\n'),
    )
    const run = (args: string[]) =>
      exec('openssl', args, {
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
        timeout: 10_000,
      })
    for (const path of [caKey, leafKey])
      await run([
        'ecparam',
        '-name',
        'prime256v1',
        '-genkey',
        '-noout',
        '-out',
        path,
      ])
    await run([
      'req',
      '-x509',
      '-new',
      '-key',
      caKey,
      '-sha256',
      '-days',
      '365',
      '-subj',
      '/CN=Vela credential proxy CA',
      '-config',
      caExt,
      '-out',
      caCert,
    ])
    await run([
      'req',
      '-new',
      '-key',
      leafKey,
      '-sha256',
      '-subj',
      '/CN=Vela credential proxy',
      '-config',
      caExt,
      '-out',
      leafRequest,
    ])
    await run([
      'x509',
      '-req',
      '-in',
      leafRequest,
      '-CA',
      caCert,
      '-CAkey',
      caKey,
      '-set_serial',
      `0x${randomBytes(16).toString('hex')}`,
      '-sha256',
      '-days',
      '365',
      '-extfile',
      leafExt,
      '-out',
      leafCert,
    ])
    const [ca, key, cert] = await Promise.all(
      [caCert, leafKey, leafCert].map((file) => readFile(file, 'utf8')),
    )
    return { ca: ca!, key: key!, cert: cert! }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw Error('OpenSSL is required on the host for Docker credentials')
    throw Error('Could not create Docker credential proxy TLS identity')
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
}
