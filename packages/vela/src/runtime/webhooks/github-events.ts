import { z } from 'zod'
import type { VelaLogger } from '../../shared/logger.ts'

const identity = z.string().trim().min(1).max(512)

export const webhookEventSchema = z
  .object({
    source: identity,
    key: identity,
    deliveryId: identity,
    summary: z.string().min(1).max(500),
    details: z.string().max(8192).optional(),
    final: z.boolean().optional(),
  })
  .strict()

export type RuntimeWebhookEvent = z.infer<typeof webhookEventSchema>

const issueLabelNames = z.array(z.string().trim().min(1))
const issueLabelFilter = z.union([
  issueLabelNames,
  z
    .object({
      all: issueLabelNames.optional(),
      any: issueLabelNames.optional(),
    })
    .strict(),
])
type IssueLabelFilter = z.infer<typeof issueLabelFilter>

export const githubWebhookOptions = z
  .object({
    secret: z.string().min(1),
    repositories: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[\w.-]+\/[\w.-]+$/),
      )
      .min(1),
    apps: z.array(z.string().trim().min(1)).default(['github-actions']),
    /** Issue feed guard: any-of array or all/any groups. Empty is silent. */
    issueLabels: issueLabelFilter.default([]),
  })
  .strict()

const record = z.record(z.string(), z.unknown())
const envelope = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
})
const numberSchema = z.number().int().positive()
const actor = z.object({ login: z.string() })
const label = z.object({ name: z.string() })
const labelList = z.array(label).default([])
const content = z.object({
  body: z.string().nullable(),
  user: actor,
  html_url: z.string(),
})
const review = content.extend({
  state: z.string(),
  commit_id: z.string(),
  id: z.number().int().positive().optional(),
})
const pr = z.object({
  number: numberSchema,
  merged: z.boolean(),
  html_url: z.string(),
  title: z.string(),
  user: actor,
  head: z.object({ sha: z.string() }),
})
const issue = z.object({
  number: numberSchema,
  title: z.string(),
  html_url: z.string(),
  user: actor,
  body: z.string().nullable(),
  labels: labelList,
})
const suite = z.object({
  app: z.object({ slug: z.string().optional() }),
  head_sha: z.string(),
  conclusion: z.string().nullable(),
  updated_at: z.string(),
  url: z.string(),
  pull_requests: z.array(z.object({ number: numberSchema })),
})

function bounded(text: string, limit: number): string {
  const marker = '\n[truncated]'
  return text.length <= limit
    ? text
    : text.slice(0, limit - marker.length) + marker
}

/** The marker is a convention, not authentication; inspect the full body, before truncation. */
function ownBody(body: string): boolean {
  return body.trimEnd().split(/\r?\n/).at(-1) === '<!-- vela:event-origin -->'
}

function allowedByLabels(
  item: { labels: readonly { name: string }[] },
  filter: IssueLabelFilter,
  applied?: string,
): boolean {
  const all = Array.isArray(filter) ? [] : (filter.all ?? [])
  const any = Array.isArray(filter) ? filter : (filter.any ?? [])
  if (applied !== undefined) {
    if (!all.length) return any.includes(applied)
    if (!all.includes(applied) && !any.includes(applied)) return false
  }
  if (!all.length && !any.length) return false
  return (
    all.every((name) => item.labels.some((l) => l.name === name)) &&
    (!any.length || item.labels.some((l) => any.includes(l.name)))
  )
}

/** Pure mapping after authentication. Never fetches payload links or guesses missing PR mappings. */
export function parseGithubWebhookEvents(
  type: string,
  input: unknown,
  deliveryId: string,
  options: z.infer<typeof githubWebhookOptions>,
  logger: VelaLogger,
): RuntimeWebhookEvent[] {
  const actions: Record<string, readonly string[]> = {
    check_suite: ['completed'],
    pull_request_review: ['submitted'],
    issue_comment: ['created'],
    pull_request: ['closed'],
    issues: ['opened', 'closed', 'labeled'],
  }
  if (!(type in actions)) {
    logger.debug(
      `[events] GitHub ${JSON.stringify(type.slice(0, 64))} event type is not mapped; dropped`,
    )
    return []
  }
  const raw = record.parse(input)
  if (!actions[type]?.includes(String(raw.action))) return []
  const { repository } = envelope.parse(raw)
  const repo = repository.full_name
  if (
    !options.repositories.some(
      (allowed) => allowed.toLowerCase() === repo.toLowerCase(),
    )
  ) {
    logger.debug('[events] GitHub repository outside allowlist; dropped')
    return []
  }
  const event = (
    key: string,
    summary: string,
    details: string,
    final?: boolean,
  ): RuntimeWebhookEvent => ({
    source: 'github',
    key,
    deliveryId,
    summary: bounded(summary, 500),
    details: bounded(details, 8192),
    ...(final ? { final: true } : {}),
  })
  const prEvent = (
    prNumber: number,
    summary: string,
    details: string,
    final?: boolean,
  ) => event(`github:${repo}#pr/${prNumber}`, summary, details, final)
  const feedEvent = (summary: string, details: string) =>
    event(`github:${repo}#issues`, summary, details)
  if (type === 'check_suite') {
    const check = suite.parse(raw.check_suite)
    if (!check.app.slug || !options.apps.includes(check.app.slug)) return []
    if (!check.pull_requests.length) {
      logger.info('[events] GitHub check_suite has no PR mapping; dropped')
      return []
    }
    return [...new Set(check.pull_requests.map((p) => p.number))].map((p) =>
      prEvent(
        p,
        `GitHub check suite ${check.app.slug} completed: ${check.conclusion ?? 'unknown'} (SHA ${check.head_sha})`,
        `Repository: ${repo}\nPR: #${p}\nSuite: ${check.app.slug}\nSHA: ${check.head_sha}\nConclusion: ${check.conclusion ?? 'unknown'}\nUpdated: ${check.updated_at}\n${check.url}`,
      ),
    )
  }
  if (type === 'issues') {
    const item = issue.parse(raw.issue)
    const details = `Issue: #${item.number} ${item.title}\nAuthor: ${item.user.login}\n${item.html_url}`
    if (raw.action === 'labeled') {
      const { name } = label.parse(raw.label)
      if (!allowedByLabels(item, options.issueLabels, name)) return []
      return [
        feedEvent(
          `GitHub issue #${item.number} labeled ${name}: ${item.title}`,
          `${details}\nLabel: ${name}`,
        ),
      ]
    }
    if (!allowedByLabels(item, options.issueLabels)) return []
    if (raw.action === 'closed')
      return [
        feedEvent(
          `GitHub issue #${item.number} closed: ${item.title}`,
          details,
        ),
      ]
    return [
      feedEvent(
        `GitHub issue #${item.number} opened: ${item.title}`,
        `${details}\n${item.body ?? ''}`,
      ),
    ]
  }
  if (type === 'issue_comment') {
    const target = z
      .object({
        number: numberSchema,
        title: z.string(),
        pull_request: record.optional(),
        labels: labelList,
      })
      .parse(raw.issue)
    const comment = content.parse(raw.comment)
    if (ownBody(comment.body ?? '')) return []
    if (!target.pull_request) {
      if (!allowedByLabels(target, options.issueLabels)) return []
      return [
        feedEvent(
          `GitHub issue #${target.number}: comment by ${comment.user.login}`,
          `Issue: #${target.number} ${target.title}\nAuthor: ${comment.user.login}\n${comment.html_url}\n${comment.body ?? ''}`,
        ),
      ]
    }
    return [
      prEvent(
        target.number,
        `GitHub PR #${target.number}: comment by ${comment.user.login}`,
        `Author: ${comment.user.login}\n${comment.html_url}\n${comment.body ?? ''}`,
      ),
    ]
  }
  if (type === 'pull_request_review') {
    const target = z.object({ number: numberSchema }).parse(raw.pull_request)
    const item = review.parse(raw.review)
    if (ownBody(item.body ?? '')) return []
    const comments = item.id
      ? `\nReview ID: ${item.id}\nInline comments: GET /repos/${repo}/pulls/${target.number}/reviews/${item.id}/comments`
      : ''
    return [
      prEvent(
        target.number,
        `GitHub PR #${target.number}: ${item.user.login} submitted review (${item.state})`,
        `Reviewer: ${item.user.login}\nState: ${item.state}\nCommit SHA: ${item.commit_id}${comments}\n${item.html_url}\n${item.body ?? ''}`,
      ),
    ]
  }
  const target = pr.parse(raw.pull_request)
  const state = target.merged ? 'merged' : 'closed without merge'
  return [
    prEvent(
      target.number,
      `GitHub PR #${target.number} ${state}: ${target.title}`,
      `Author: ${target.user.login}\nState: ${state}\nHead SHA: ${target.head.sha}\n${target.html_url}`,
      true,
    ),
  ]
}
