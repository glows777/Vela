import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import icon from '../assets/vela-icon-180.png'
import type { DesktopBridge, Message, Project } from '../shared/bridge.ts'
import '../styles/base.css'

declare global {
  interface Window {
    vela: DesktopBridge
  }
}

/** Minimal SDK-host exercise; product pages are separate work. */
function App() {
  const [cwd, setCwd] = useState('')
  const [input, setInput] = useState('')
  const [project, setProject] = useState<Project>()
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState('')
  useEffect(
    () =>
      window.vela.onEvent((event) => {
        if (
          event.type === 'local' &&
          event.value.type === 'message' &&
          event.value.projectId === project?.id
        ) {
          const message = event.value.data
          setMessages((current) =>
            current.some((m) => m.id === message.id)
              ? current
              : [...current, message],
          )
        }
      }),
    [project],
  )
  const open = async () => {
    try {
      const next = await window.vela.openProject({ cwd })
      setProject(next)
      const history: Message[] = []
      let after: string | undefined
      do {
        const page = await window.vela.messages({
          projectId: next.id,
          sessionId: next.sessionId,
          after,
        })
        history.push(...page.messages)
        after = page.nextCursor
      } while (after)
      setMessages(history)
      setError('')
    } catch (cause) {
      setError(String(cause))
    }
  }
  const send = async () => {
    if (!project || !input.trim()) return
    try {
      await window.vela.submit('local', {
        projectId: project.id,
        sessionId: project.sessionId,
        text: input,
      })
      setInput('')
      setError('')
    } catch (cause) {
      setError(String(cause))
    }
  }
  return (
    <main className="shell" aria-label="Vela desktop">
      <div className="brand">
        <img src={icon} width="72" height="72" alt="" />
        <h1 className="wordmark">VELA</h1>
      </div>
      <label>
        Project path
        <input
          aria-label="Project path"
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
        />
      </label>
      <button type="button" onClick={() => void open()}>
        Open project
      </button>
      {project && (
        <>
          <label>
            Message
            <input
              aria-label="Message"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
          </label>
          <button type="button" onClick={() => void send()}>
            Send
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <div aria-live="polite">
        {messages.map((message) => (
          <p key={message.id}>{message.text}</p>
        ))}
      </div>
    </main>
  )
}
const root = document.getElementById('root')
if (!root) throw new Error('Missing renderer root')
createRoot(root).render(
  <StrictMode>
    {new URLSearchParams(location.search).has('hostError') ? (
      <main className="shell">
        <p role="alert">
          Vela could not start. Check your settings and restart.
        </p>
      </main>
    ) : (
      <App />
    )}
  </StrictMode>,
)
