import { APICallError } from '@ai-sdk/provider'
import type { ProviderApiErrorInfo } from '../shared/provider-types.ts'

/** Extract normalized metadata from an AI SDK `APICallError`, or undefined for other errors. */
export function inspectProviderApiError(
  error: unknown,
): ProviderApiErrorInfo | undefined {
  if (!APICallError.isInstance(error)) return undefined
  return {
    statusCode: error.statusCode,
    responseBody: error.responseBody,
    responseHeaders: error.responseHeaders as
      | Record<string, string>
      | undefined,
    isRetryable: error.isRetryable,
    message: error.message,
  }
}
