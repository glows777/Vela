import { ArrowRight } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { restoreDraft } from '../../shared/draft.ts'
import styles from './composer.module.css'

/** Unsent text per conversation, so switching away and back keeps what was typed. */
const drafts = new Map<string, string>()

/**
 * One composer for Home, a project and a session. Enter sends, Shift+Enter adds a
 * line, and an IME composition keeps its Enter. The field clears at once; a rejected
 * submission puts its text back above whatever was typed since, so neither draft is
 * lost. `draftKey` gives each conversation its own unsent text.
 */
export function Composer({
  label,
  hint,
  draftKey,
  running = false,
  focusSignal = 0,
  onSend,
  children,
}: {
  label: string
  hint?: ReactNode
  draftKey: string
  /** Draws the composer edge that marks a live run (app.md, Running). */
  running?: boolean
  focusSignal?: number
  onSend: (text: string) => Promise<boolean>
  children?: ReactNode
}) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '')
  const field = useRef<HTMLTextAreaElement>(null)
  const write = (next: string) => {
    setText(next)
    drafts.set(draftKey, next)
  }

  useEffect(() => {
    if (focusSignal > 0) field.current?.focus()
  }, [focusSignal])

  const submit = () => {
    const body = text.trim()
    if (!body) return
    write('')
    const restore = () => write(restoreDraft(body, drafts.get(draftKey) ?? ''))
    void Promise.resolve(onSend(body)).then(
      (accepted) => {
        if (!accepted) restore()
      },
      () => restore(),
    )
  }

  return (
    <div className={styles.wrap}>
      <form
        className={[styles.composer, running ? styles.running : '']
          .filter(Boolean)
          .join(' ')}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={field}
          className={styles.text}
          aria-label={label}
          placeholder={label}
          rows={2}
          value={text}
          onChange={(event) => write(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className={styles.tools}>
          {children}
          <span className={styles.spacer} />
          <button
            type="submit"
            className={styles.send}
            aria-label="Send"
            disabled={text.trim() === ''}
          >
            <ArrowRight size={20} aria-hidden="true" />
          </button>
        </div>
      </form>
      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </div>
  )
}
