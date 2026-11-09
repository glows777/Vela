// This entry runs inside bubblewrap, without provider credentials or evaluation files.
const [source, name, cwd] = process.argv.slice(2) as [string, string, string]
const extension = source.endsWith('/dist') ? 'js' : 'ts'
const { createCoreTools } = await import(
  `/runtime/${source}/tools/index.${extension}`
)
const { ToolResultStore, StoredToolResult } = await import(
  `/runtime/${source}/session/tool-results.${extension}`
)
const { ToolExecutionResult } = await import(
  `/runtime/${source}/tools/types.${extension}`
)
const request = JSON.parse(await Bun.stdin.text())
const registry = request.fileState === undefined ? undefined : {}
const state = registry
  ? (
      await import(`/runtime/${source}/tools/file-write-guard.${extension}`)
    ).stateFor({ registry })
  : undefined
if (state)
  for (const [key, entries] of request.fileState) {
    if (!(state[key] instanceof Map))
      throw new Error('Unsupported native file state')
    for (const [path, value] of entries) state[key].set(path, value)
  }
const snapshot = () =>
  state
    ? Object.entries(state).map(([key, value]) => {
        if (!(value instanceof Map))
          throw new Error('Unsupported native file state')
        return [key, [...value]]
      })
    : undefined
try {
  const tool = createCoreTools({ cwd, shellPath: '/bin/bash' }).find(
    (item: { name: string }) => item.name === name,
  )
  if (!tool) throw new Error('Unknown isolated tool')
  const result = await tool.execute(request.input, {
    results: new ToolResultStore(request.resultsDir),
    registry,
    callId: request.callId,
  })
  console.log(
    JSON.stringify({
      kind:
        result instanceof ToolExecutionResult
          ? 'execution'
          : result instanceof StoredToolResult
            ? 'stored'
            : 'value',
      result,
      fileState: snapshot(),
    }),
  )
} catch (error) {
  console.log(
    JSON.stringify({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      fileState: snapshot(),
    }),
  )
}
