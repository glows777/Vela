// Journey scripts create their fixtures relative to the working directory. Under vela-verify.sh exec
// that is the run's disposable work directory; started directly with bun it would be the caller's
// checkout, so those runs move to a temporary directory instead.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function prepareWorkspace(): void {
  if (process.env.VELA_VERIFY === '1') return
  const dir = mkdtempSync(join(tmpdir(), 'vela-journey-'))
  process.chdir(dir)
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  console.error(`workspace: ${dir}`)
}
