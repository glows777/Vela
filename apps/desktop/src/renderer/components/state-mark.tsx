import {
  Check,
  Circle,
  CircleDashed,
  CircleHelp,
  CircleSlash,
} from 'lucide-react'
import type { Session } from '../../shared/bridge.ts'
import styles from './state-mark.module.css'

const marks = {
  running: Circle,
  queued: CircleDashed,
  waiting: CircleHelp,
  done: Check,
  stopped: CircleSlash,
} as const

/** The icon that goes with a session's one state word (app.md, states). */
export function StateMark({ state }: { state: Session['state'] }) {
  const Icon = marks[state]
  return (
    <Icon
      className={[styles.mark, styles[state]].join(' ')}
      size={16}
      aria-hidden="true"
    />
  )
}
