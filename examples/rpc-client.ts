/**
 * A minimal `vela --mode rpc` client: starts Vela as a child process, sends one prompt, prints the
 * streamed text and tool calls, waits for `agent_settled`, then closes stdin so Vela exits.
 *
 * Run it offline from the repository root with the demo model and a throwaway agent directory:
 *
 *   VELA_MODEL=mock VELA_DIR=$(mktemp -d) bun examples/rpc-client.ts "list files"
 *
 * By default it starts `bun src/cli/main.ts`; set VELA_RPC_COMMAND to start something else,
 * for example `VELA_RPC_COMMAND=vela` when the package is installed.
 * The child inherits this process's environment (VELA_MODEL, VELA_DIR, API keys, ...).
 * Uses only `node:` modules, so it also runs with `node examples/rpc-client.ts`.
 */
import { spawn } from 'node:child_process'

type RpcRecord = { type: string; [key: string]: unknown }

const prompt = process.argv.slice(2).join(' ') || 'list files'
const [command = 'bun', ...commandArgs] = (
  process.env.VELA_RPC_COMMAND ?? 'bun src/cli/main.ts'
)
  .split(' ')
  .filter(Boolean)

const child = spawn(command, [...commandArgs, '--mode', 'rpc'], {
  stdio: ['pipe', 'pipe', 'inherit'],
})

let failed = false
const send = (record: Record<string, unknown>) =>
  child.stdin.write(`${JSON.stringify(record)}\n`)

/** Called for every record on stdout. Returns true once the run is over. */
function handle(record: RpcRecord): boolean {
  switch (record.type) {
    case 'response':
      if (!record.success) {
        console.error(`\n[${record.command} failed] ${record.error}`)
        failed = true
        // A prompt rejected outright never starts a run, so there is no agent_settled to wait for. A prompt that
        // fails after `started` (no model, extension hook) gets this response after agent_settled; the reader
        // below keeps reading until Vela exits, so it is still printed
        return record.id === 'prompt-1'
      }
      return false
    case 'message_update': {
      const update = record.assistantMessageEvent as {
        type: string
        delta?: string
      }
      if (update.type === 'text_delta')
        process.stdout.write(String(update.delta))
      return false
    }
    case 'tool_execution_start':
      console.log(`\n[tool] ${record.toolName} ${JSON.stringify(record.args)}`)
      return false
    case 'tool_execution_end':
      if (record.isError) console.log(`[tool error] ${record.toolName}`)
      return false
    case 'agent_end':
      if (record.reason !== 'done') {
        console.error(`\n[agent_end] ${record.reason}`)
        failed = true
      }
      return false
    case 'extension_ui_request':
      // No user to ask here: cancel dialogs (confirm → false, select / input → undefined)
      if (['confirm', 'select', 'input'].includes(String(record.method)))
        send({ type: 'extension_ui_response', id: record.id, cancelled: true })
      return false
    case 'agent_settled':
      process.stdout.write('\n')
      return true
    default:
      return false
  }
}

// Split stdout on "\n" only: node:readline would also split on U+2028 / U+2029, which are valid inside JSON strings
const done = new Promise<void>((resolve) => {
  const decoder = new TextDecoder()
  let buffer = ''
  child.stdout.on('data', (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (line && handle(JSON.parse(line) as RpcRecord)) resolve()
    }
  })
  child.on('exit', () => resolve())
})

send({ id: 'prompt-1', type: 'prompt', message: prompt })
await done

// Closing stdin asks Vela to abort anything still running, save and exit
child.stdin.end()
const code = await new Promise<number | null>((resolve) => {
  if (child.exitCode !== null) resolve(child.exitCode)
  else child.on('exit', (exitCode) => resolve(exitCode))
})
process.exitCode = failed ? 1 : (code ?? 1)
