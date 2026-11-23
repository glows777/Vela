import type { ToolExecutionMode, ToolExposure } from './types.ts'

const EXPOSURES: readonly ToolExposure[] = [
  'direct',
  'model-only',
  'codemode',
  'deferred',
  'hidden',
]

/** Validate declaration semantics once, before publishing a tool to its scope. */
export function validateToolDefinition(tool: {
  name: string
  exposure?: ToolExposure
  executionMode?: ToolExecutionMode
}): void {
  // Removed in favor of executionMode; ignoring it would silently change how the tool runs
  if ('isConcurrencySafe' in tool)
    throw new Error(
      `Tool "${tool.name}": isConcurrencySafe was removed. Drop isConcurrencySafe: true; replace isConcurrencySafe: false with executionMode: 'sequential'.`,
    )
  if ('isReadOnly' in tool)
    throw new Error(
      `Tool "${tool.name}": isReadOnly was removed. Use annotations: { readOnlyHint: true } (same as pi).`,
    )
  if (tool.exposure !== undefined && !EXPOSURES.includes(tool.exposure))
    throw new Error(
      `Tool "${tool.name}": exposure must be one of ${EXPOSURES.join(', ')}, got ${JSON.stringify(tool.exposure)}`,
    )
  if (
    tool.executionMode !== undefined &&
    tool.executionMode !== 'parallel' &&
    tool.executionMode !== 'sequential'
  )
    throw new Error(
      `Tool "${tool.name}": executionMode must be 'parallel' or 'sequential', got ${JSON.stringify(tool.executionMode)}`,
    )
}
