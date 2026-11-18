import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from './arc/button/button.tsx'
import styles from './composer.module.css'

/**
 * One composer for Home and a project. Enter sends, Shift+Enter adds a line, and an
 * IME composition keeps its Enter. The field clears at once; a rejected submission
 * puts the draft back if the person has not typed something else.
 */
export function Composer({
  label,
  hint,
  focusSignal = 0,
  onSend,
  children,
}: {
  label: string
  hint?: ReactNode
  focusSignal?: number
  onSend: (text: string) => Promise<boolean>
  children?: ReactNode
}) {
  const [text, setText] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (focusSignal > 0) field.current?.focus()
  }, [focusSignal])

  const submit = () => {
    const body = text.trim()
    if (!body) return
    setText('')
    const restore = () =>
      setText((current) => (current === '' ? body : current))
    void Promise.resolve(onSend(body)).then(
      (accepted) => {
        if (!accepted) restore()
      },
      () => restore(),
    )
  }

  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {children}
      <div className={styles.field}>
        <textarea
          ref={field}
          className={styles.text}
          aria-label={label}
          placeholder={label}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <Button type="submit" size="lg" disabled={text.trim() === ''}>
          Send
        </Button>
      </div>
      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </form>
  )
}
