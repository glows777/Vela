import { type ComponentPropsWithoutRef, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Message } from '../../shared/bridge.ts'
import { vela } from '../vela.ts'
import styles from './message.module.css'

function CodeBlock({ children }: ComponentPropsWithoutRef<'pre'>) {
  const [copy, setCopy] = useState('Copy')
  const block = useRef<HTMLPreElement>(null)
  return (
    <div className={styles.codeBlock}>
      <button
        type="button"
        className={styles.copy}
        onClick={() => {
          const text = block.current?.textContent ?? ''
          void vela.copyMessageCode(text.replace(/\n$/, '')).then(
            () => setCopy('Copied'),
            () => setCopy('Could not copy'),
          )
        }}
      >
        {copy}
      </button>
      <pre ref={block}>{children}</pre>
    </div>
  )
}

function MessageLink({ children, href }: ComponentPropsWithoutRef<'a'>) {
  const [failed, setFailed] = useState(false)
  if (!href) return <>{children}</>
  return (
    <>
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault()
          setFailed(false)
          void vela.openMessageLink(href).catch(() => setFailed(true))
        }}
      >
        {children}
      </a>
      {failed ? <span role="status"> Could not open link.</span> : null}
    </>
  )
}

const httpLink = (href: string) => {
  if (!URL.canParse(href)) return ''
  const url = new URL(href)
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
}

/**
 * A person's message is a plain-text bubble; Vela answers in Markdown. In a
 * Lark group every person keeps their name, and the app's own posts are the bot's.
 */
export function MessageView({
  message,
  group = false,
}: {
  message: Message
  group?: boolean
}) {
  if (message.role === 'system')
    return (
      <p className={styles.system} data-role="system">
        {message.text}
      </p>
    )
  if (message.role === 'user')
    return group ? (
      <div className={styles.person} data-role="user">
        <p className={styles.name}>{message.senderName ?? 'Someone'}</p>
        <p className={styles.bubble}>{message.text}</p>
      </div>
    ) : (
      <div className={styles.user} data-role="user">
        <p className={styles.bubble}>{message.text}</p>
      </div>
    )
  return (
    <article className={styles.assistant} data-role="assistant">
      <div className={styles.text}>
        <Markdown
          skipHtml
          disallowedElements={['img']}
          remarkPlugins={[remarkGfm]}
          urlTransform={httpLink}
          components={{
            a: MessageLink,
            pre: CodeBlock,
            table: ({ children }) => (
              <div className={styles.table}>
                <table>{children}</table>
              </div>
            ),
          }}
        >
          {message.text}
        </Markdown>
      </div>
    </article>
  )
}
