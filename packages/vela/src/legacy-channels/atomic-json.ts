import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Share the directory's synced temporary-file replacement protocol. */
export async function writeAtomicJson(
  path: string,
  value: unknown,
): Promise<void> {
  await writeAtomicFile(path, `${JSON.stringify(value)}\n`)
}

export async function writeAtomicFile(
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(contents)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
