import type { SelectItem } from '@earendil-works/pi-tui'
import type { VelaSession } from '../../core.ts'
import { messageText, type SessionEntry } from '../../session/entries.ts'
import { errorMessage, oneLine, sanitize } from './components.ts'
import { nearestShown, treeItems } from './tree-selector.ts'

interface TreeHost {
  session: VelaSession
  options: { newSessionId: () => string }
  select(
    title: string,
    items: SelectItem[],
    selected?: string,
  ): Promise<string | undefined>
  input(
    title: string,
    placeholder?: string,
    signal?: AbortSignal,
    secret?: boolean,
  ): Promise<string | undefined>
  addNotice(text: string, level?: 'info' | 'warning' | 'error' | 'dim'): void
  busyNotice(): boolean
  startLoader(message: string): void
  stopLoader(): void
  resetChat(): void
  renderHistory(branch: SessionEntry[]): void
  updateBorder(): void
  switchSession(id: string, resume: boolean): Promise<void>
  editor: { setText(text: string): void }
  tui: { requestRender(): void }
}

export async function treeCommand(host: TreeHost): Promise<void> {
  if (host.busyNotice()) return
  const session = host.session
  const branch = session.getBranch()
  const items = treeItems(
    session.getTree(),
    new Set(branch.map((entry) => entry.id)),
    null,
  )
  if (!items.length) {
    host.addNotice('No messages in this session yet', 'dim')
    return
  }
  const current = nearestShown(branch, items)
  for (const item of items)
    if (item.value === current) item.description = '← current'
  const targetId = await host.select('Session Tree', items, current)
  if (!targetId) return
  const action = await host.select('Move here', [
    { value: 'go', label: 'No summary' },
    { value: 'summarize', label: 'Summarize the branch I leave' },
    { value: 'focus', label: 'Summarize with a focus…' },
    { value: 'label', label: 'Set a label on this entry…' },
  ])
  if (!action) return
  if (action === 'label') {
    const label = await host.input('Label', 'empty clears the label')
    try {
      session.setLabel(targetId, label)
      await session.save()
      host.addNotice(label ? `Label set: ${label}` : 'Label cleared', 'dim')
    } catch (error) {
      host.addNotice(errorMessage(error), 'error')
    }
    return
  }
  let focus: string | undefined
  if (action === 'focus') {
    focus = await host.input('Summary focus', 'what the summary should keep')
    if (focus === undefined) return
  }
  const atLeaf =
    targetId === session.getLeafId() &&
    !session
      .getBranch()
      .some(
        (entry) =>
          entry.id === targetId &&
          entry.type === 'message' &&
          entry.message.role === 'user',
      )
  if (atLeaf) {
    host.addNotice('Already at this point', 'dim')
    return
  }
  if (action !== 'go') host.startLoader('Summarizing branch…')
  try {
    const result = await session.navigateTree(targetId, {
      summarize: action !== 'go',
      focus,
    })
    if (result.cancelled) {
      host.addNotice('Navigation cancelled', 'dim')
      return
    }
    host.resetChat()
    host.renderHistory(session.getBranch())
    if (result.editorText !== undefined) host.editor.setText(result.editorText)
    host.addNotice('Moved in the session tree', 'dim')
  } catch (error) {
    host.addNotice(`Navigation failed: ${errorMessage(error)}`, 'error')
  } finally {
    host.stopLoader()
    host.updateBorder()
    host.tui.requestRender()
  }
}

/** `/fork` (pick an earlier user message) and `/clone` (the current branch), like pi: switch to the copy. */
export async function forkCommand(
  host: TreeHost,
  clone = false,
): Promise<void> {
  if (host.busyNotice()) return
  const session = host.session
  let entryId: string | undefined
  if (!clone) {
    const users = session
      .getEntries()
      .flatMap((entry) =>
        entry.type === 'message' && entry.message.role === 'user'
          ? [{ id: entry.id, text: messageText(entry.message.content) }]
          : [],
      )
    if (!users.length) {
      host.addNotice('No messages to fork from', 'dim')
      return
    }
    entryId = await host.select(
      'Fork from before',
      users.map((user) => ({
        value: user.id,
        label: oneLine(sanitize(user.text)).slice(0, 80),
      })),
      users.at(-1)?.id,
    )
    if (!entryId) return
  }
  try {
    const result = clone
      ? await session.clone({ sessionId: host.options.newSessionId() })
      : await session.fork(entryId as string, {
          sessionId: host.options.newSessionId(),
        })
    if (result.cancelled || !result.session) {
      host.addNotice(`${clone ? 'Clone' : 'Fork'} cancelled`, 'dim')
      return
    }
    await host.switchSession(result.session.id, false)
    host.editor.setText(result.selectedText ?? '')
    host.addNotice(
      clone ? 'Cloned to a new session' : 'Forked to a new session',
      'dim',
    )
  } catch (error) {
    host.addNotice(
      `${clone ? 'Clone' : 'Fork'} failed: ${errorMessage(error)}`,
      'error',
    )
  }
  host.tui.requestRender()
}
