import type { SessionTreeEvent, TreePreparation } from '../extensions/events.ts'
import type { ForkResult } from './deps.ts'
import type { BranchSummaryEntry, SessionEntry } from './entries.ts'
import { messageText } from './entries.ts'
import type { SessionStore } from './index.ts'
import type { NavigateTreeOptions, SessionOptions } from './options.ts'
import { newSessionId } from './session-id.ts'

export function forkPoint(
  store: SessionStore,
  entryId: string,
  position: 'before' | 'at',
) {
  const entry = store.getEntry(entryId)
  if (!entry) throw new Error(`Entry ${entryId} is not in the session`)
  let leafId: string | null = entryId
  let selectedText: string | undefined
  if (position === 'before') {
    if (entry.type !== 'message' || entry.message.role !== 'user')
      throw new Error(`Entry ${entryId} is not a user message to fork from`)
    leafId = entry.parentId
    selectedText = messageText(entry.message.content)
  }
  return { leafId, selectedText }
}

export async function copyFork<
  S extends {
    store: SessionStore
    close(): Promise<void>
    seedFrom(parent: S, branch: SessionEntry[]): Promise<void>
  },
>(
  parent: S,
  point: ReturnType<typeof forkPoint>,
  sessionId: string | undefined,
  open: (id: string, options: SessionOptions) => S,
  options: SessionOptions,
): Promise<ForkResult<S>> {
  const { leafId, selectedText } = point
  const branch = leafId === null ? [] : parent.store.getBranch(leafId)
  const session = open(sessionId ?? newSessionId(), options)
  try {
    await session.seedFrom(parent, branch)
  } catch (error) {
    await session.close()
    throw error
  }
  return {
    cancelled: false,
    session,
    ...(selectedText === undefined ? {} : { selectedText }),
  }
}

export function cloneLeaf(store: SessionStore): string {
  const leafId = store.getLeafId()
  // Setup entries (model, thinking level) alone are not a conversation to copy
  const hasConversation = store
    .getBranch()
    .some(
      (entry) =>
        entry.type === 'custom_message' ||
        entry.type === 'bash_execution' ||
        (entry.type === 'message' &&
          (entry.message.role === 'user' ||
            entry.message.role === 'assistant')),
    )
  if (!leafId || !hasConversation) throw new Error('Nothing to clone yet')
  return leafId
}

/** The old branch and the part a tree move would leave behind. */
function prepareTree(
  store: SessionStore,
  targetId: string,
  oldLeafId: string | null,
  options: NavigateTreeOptions,
) {
  const oldBranch = store.getBranch(oldLeafId)
  const targetIds = new Set(store.getBranch(targetId).map((entry) => entry.id))
  let common = -1
  while (
    common + 1 < oldBranch.length &&
    targetIds.has((oldBranch[common + 1] as SessionEntry).id)
  )
    common++
  const commonAncestorId = oldBranch[common]?.id ?? null
  const preparation: TreePreparation = {
    targetId,
    oldLeafId,
    commonAncestorId,
    entriesToSummarize: oldBranch.slice(common + 1),
    userWantsSummary: options.summarize ?? false,
    ...(options.focus ? { focus: options.focus } : {}),
    ...(options.label ? { label: options.label } : {}),
  }
  return { oldBranch, common, preparation }
}

export async function executeTreeNavigation<S>(params: {
  session: S
  store: SessionStore
  target: SessionEntry
  oldLeafId: string | null
  options: NavigateTreeOptions
  signal: AbortSignal
  beforeTree: (
    session: S,
    preparation: TreePreparation,
    signal: AbortSignal,
  ) => Promise<{
    cancel?: boolean
    focus?: string
    label?: string
    summary?: { summary: string }
  }>
  afterTree: (session: S, event: SessionTreeEvent) => Promise<void>
  summarizeBranch: (
    entries: SessionEntry[],
    focus: string | undefined,
    signal: AbortSignal,
  ) => Promise<string | undefined>
  loadBranch: (
    context: ReturnType<SessionStore['buildContext']>,
  ) => Promise<void>
  save: () => Promise<void>
}): Promise<{ editorText?: string; cancelled: boolean }> {
  const {
    session,
    store,
    target,
    oldLeafId,
    options,
    signal,
    beforeTree,
    afterTree,
    summarizeBranch,
    loadBranch,
    save,
  } = params
  const { preparation } = prepareTree(store, target.id, oldLeafId, options)
  const hook = await beforeTree(session, preparation, signal)
  if (hook.cancel) return { cancelled: true }
  const focus = hook.focus ?? options.focus
  const label = (hook.label ?? options.label)?.trim() || undefined
  let summary: string | undefined
  let fromExtension = false
  if (options.summarize && preparation.entriesToSummarize.length) {
    if (hook.summary) {
      summary = hook.summary.summary
      fromExtension = true
    } else {
      try {
        summary = await summarizeBranch(
          preparation.entriesToSummarize,
          focus,
          signal,
        )
      } catch (error) {
        if (signal.aborted) return { cancelled: true }
        throw error
      }
    }
  }
  const { editorText, event } = selectTreeBranch(
    store,
    target,
    oldLeafId,
    summary,
    label,
    fromExtension,
  )
  await loadBranch(store.buildContext())
  await afterTree(session, event)
  await save()
  return {
    ...(editorText === undefined ? {} : { editorText }),
    cancelled: false,
  }
}

function selectTreeBranch(
  store: SessionStore,
  target: SessionEntry,
  oldLeafId: string | null,
  summary: string | undefined,
  label: string | undefined,
  fromExtension: boolean,
) {
  let newLeafId: string | null = target.id
  let editorText: string | undefined
  if (target.type === 'message' && target.message.role === 'user') {
    newLeafId = target.parentId
    editorText = messageText(target.message.content)
  }
  let summaryEntry: BranchSummaryEntry | undefined
  if (summary) {
    summaryEntry = store.branchWithSummary(newLeafId, summary)
    if (label) store.appendLabelChange(summaryEntry.id, label)
  } else {
    store.branch(newLeafId)
    if (label) store.appendLabelChange(target.id, label)
  }
  const event: SessionTreeEvent = {
    type: 'session_tree',
    newLeafId: store.getLeafId(),
    oldLeafId,
    ...(summaryEntry
      ? { summaryEntry: structuredClone(summaryEntry), fromExtension }
      : {}),
  }
  return { editorText, event }
}
