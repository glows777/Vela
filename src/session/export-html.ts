import type { ModelMessage } from 'ai'
import {
  type ToolResultOutput,
  toolResultOutputToText,
} from '../context/tool-result-output.ts'
import type { SessionEntry } from './entries.ts'

/** What `renderSessionHtml()` renders. */
export interface SessionHtmlInput {
  id: string
  name?: string
  /** Current model (`provider/id`), if chosen by name */
  model?: unknown
  /** The branch to render, root first */
  entries: SessionEntry[]
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escapes text for HTML content and attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] as string)
}

const text = (value: string, className = 'text') =>
  `<div class="${className}">${escapeHtml(value)}</div>`

const details = (summary: string, body: string, className: string) =>
  `<details class="${className}"><summary>${escapeHtml(summary)}</summary>${body}</details>`

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function renderMessage(message: ModelMessage): string {
  const role = message.role
  if (typeof message.content === 'string')
    return `<section class="message ${role}"><div class="role">${role}</div>${text(message.content)}</section>`
  const parts = message.content.map((part) => {
    switch (part.type) {
      case 'text':
        return text(part.text)
      case 'reasoning':
        return details('Thinking', text(part.text), 'thinking')
      case 'tool-call':
        return details(
          `Tool call: ${part.toolName}`,
          text(json(part.input), 'code'),
          'tool-call',
        )
      case 'tool-result':
        return details(
          `Result: ${part.toolName}`,
          text(toolResultOutputToText(part.output as ToolResultOutput), 'code'),
          'tool-result',
        )
      case 'file':
        return text(`[file: ${part.mediaType}]`, 'note')
      default:
        return text(`[${part.type}]`, 'note')
    }
  })
  return `<section class="message ${role}"><div class="role">${role}</div>${parts.join('')}</section>`
}

function renderEntry(entry: SessionEntry): string {
  switch (entry.type) {
    case 'message':
      return (
        renderMessage(entry.message) +
        (entry.stopReason
          ? text(
              `(${entry.stopReason === 'aborted' ? 'aborted' : 'failed'} while streaming)`,
              'note',
            )
          : '')
      )
    case 'compaction':
      return details(
        'Summary of the earlier conversation',
        text(entry.summary),
        'summary',
      )
    case 'branch_summary':
      return details(
        'Summary of a branch that was left',
        text(entry.summary),
        'summary',
      )
    case 'model_change':
      return text(`Model: ${entry.model}`, 'note')
    case 'thinking_level_change':
      return text(`Thinking level: ${entry.thinkingLevel}`, 'note')
    default:
      return ''
  }
}

const STYLE = `
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--border:#d0d7de;--user:#ddf4ff;--panel:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--border:#30363d;--user:#0c2d4a;--panel:#161b22}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 4px}
.meta{color:var(--muted);font-size:13px;margin-bottom:24px}
.message{border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin:12px 0}
.message.user{background:var(--user)}
.role{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
.text{white-space:pre-wrap;overflow-wrap:anywhere}
.code{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.45 ui-monospace,monospace;background:var(--panel);padding:8px;border-radius:6px;max-height:480px;overflow:auto}
details{margin:6px 0}
summary{cursor:pointer;color:var(--muted)}
.summary{border-left:3px solid var(--border);padding-left:10px}
.note{color:var(--muted);font-size:13px;margin:6px 0}
`

/**
 * A self-contained HTML page for one branch of a session: no scripts and no external resources, every piece
 * of session content escaped (it may hold anything a tool returned).
 */
export function renderSessionHtml(input: SessionHtmlInput): string {
  const title = input.name ?? input.id
  const model = typeof input.model === 'string' ? ` · ${input.model}` : ''
  const body = input.entries.map(renderEntry).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<div class="meta">Vela session ${escapeHtml(input.id)}${escapeHtml(model)} · exported ${escapeHtml(new Date().toISOString())}</div>
${body}
</main>
</body>
</html>
`
}
