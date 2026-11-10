import { readFile } from 'node:fs/promises'
import type { ZodType } from 'zod'

interface JsonFileErrors {
  /** Wrap a read failure; the original error is usually its `cause`. Defaults to rethrowing it. */
  read?(error: unknown): Error
  /** Wrap a JSON parse or schema failure; the original error is usually its `cause`. */
  parse(error: unknown): Error
}

/** Read and parse a JSON file, treating a missing file as absent. */
export async function readJsonIfExists<T>(
  path: string,
  schema: ZodType<T>,
  errors: JsonFileErrors,
): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw errors.read ? errors.read(error) : error
  }
  try {
    return schema.parse(JSON.parse(text))
  } catch (error) {
    throw errors.parse(error)
  }
}
