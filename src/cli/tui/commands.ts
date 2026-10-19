/** Commands the TUI handles itself (besides extension and CLI slash commands), for autocomplete */
export const TUI_COMMANDS = [
  { name: 'new', description: 'Start a new session' },
  { name: 'resume', description: 'Resume a saved session' },
  { name: 'name', description: 'Set the session name' },
  {
    name: 'model',
    description: 'Select model (/model provider/id switches directly)',
  },
  { name: 'thinking', description: 'Select thinking level' },
  { name: 'login', description: 'Sign in to a provider or store its API key' },
  { name: 'logout', description: "Remove a provider's stored credential" },
  { name: 'tree', description: 'Move to another point in the session tree' },
  {
    name: 'fork',
    description: 'Start a new session from before an earlier message',
  },
  { name: 'clone', description: 'Copy the current branch into a new session' },
  {
    name: 'export',
    description: 'Write the current branch as HTML (or .jsonl) [path]',
  },
  {
    name: 'compact',
    description: 'Manually compact the session context (optional focus)',
  },
  { name: 'copy', description: 'Copy the last answer to the clipboard' },
  { name: 'hotkeys', description: 'Show keyboard shortcuts' },
  { name: 'quit', description: 'Quit Vela' },
]
export const CLI_COMMANDS = [
  { name: 'status', description: 'Session overview' },
  { name: 'context', description: 'Context usage' },
  { name: 'usage', description: 'Token usage and cost' },
  { name: 'skill', description: 'List skills (run one with /skill:<name>)' },
  { name: 'extensions', description: 'Loaded extensions' },
  { name: 'channel', description: 'Channels' },
  { name: 'role', description: 'Show / switch role' },
  { name: 'hooks', description: 'Registered hooks' },
]

export const HOTKEYS = [
  'Enter send; while running, Enter = steer (inserted after the current step)',
  'Alt+Enter while running, queue a follow-up (after the task finishes)',
  'Alt+Up move queued messages back to the editor',
  'Esc interrupt (queued messages go back to the editor), or cancel a ! command',
  '!cmd run a shell command and send its output with the next message · !!cmd run it without sending',
  'Shift+Tab cycle thinking level · Ctrl+L select model · Ctrl+P / Shift+Ctrl+P cycle models',
  'Ctrl+O expand / collapse tool output · Ctrl+T show / hide thinking',
  `${process.platform === 'win32' ? 'Alt+V' : 'Ctrl+V'} paste a clipboard image as a file path for read_file`,
  'Ctrl+C clear editor, twice to exit · Ctrl+D exit when editor is empty',
]
