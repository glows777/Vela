/** Run with all Vela processes stopped. Dry run is the default; see docs/lark-migration.md. */
import { migrateLark } from './lark-migration.ts'

const args = process.argv.slice(2)
let dataDir: string | undefined
const settingsFiles: string[] = []
let apply = false
try {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--apply') apply = true
    else if (arg === '--data-dir' || arg === '--settings') {
      const value = args[++index]
      if (!value || value.startsWith('--'))
        throw new Error(`Missing value for ${arg}`)
      if (arg === '--data-dir') dataDir = value
      else settingsFiles.push(value)
    } else throw new Error(`Unknown argument ${arg}`)
  }
  if (!dataDir)
    throw new Error(
      'Usage: bun scripts/migrate-lark.ts --data-dir <dataDir> [--settings <settings.json>]... [--apply]',
    )
  const result = await migrateLark({ dataDir, settingsFiles, apply })
  console.log(
    JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...result }, null, 2),
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
