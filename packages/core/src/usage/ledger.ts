import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Returns `<dataDir>/usage/requests.jsonl`, the ledger the tracker appends to.
 * Releases before 0.6 wrote `today.jsonl`; that file is renamed once so usage
 * carries over. An existing `requests.jsonl` wins and the old file is kept.
 */
export function usageLedgerPath(dataDir: string): string {
  const dir = join(dataDir, 'usage')
  const next = join(dir, 'requests.jsonl')
  const previous = join(dir, 'today.jsonl')
  if (existsSync(next) || !existsSync(previous)) return next
  try {
    renameSync(previous, next)
  } catch (error) {
    // Another process using the same dataDir (`vela serve` plus a CLI, or two
    // sessions here) moved it first. Its ledger is the one we return.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `Cannot move the usage ledger from ${previous} to ${next}: ${(error as Error).message}`,
        { cause: error },
      )
    }
  }
  return next
}
