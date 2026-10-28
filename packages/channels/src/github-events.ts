import type { VelaLogger } from '@glows777/vela-core/extension-api'
import { z } from 'zod'
import type { ChannelEvent } from './types.ts'

export const githubOptions = z
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
  })
  .strict()

const record = z.record(z.string(), z.unknown())
const envelope = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
})
const number = z.number().int().positive()
const actor = z.object({ login: z.string() })
const content = z.object({
  body: z.string().nullable(),
  user: actor,
  html_url: z.string(),
})
const review = content.extend({ state: z.string(), commit_id: z.string() })
const pr = z.object({
  number,
  merged: z.boolean(),
  html_url: z.string(),
  title: z.string(),
  user: actor,
  head: z.object({ sha: z.string() }),
})
const suite = z.object({
  app: z.object({ slug: z.string().optional() }),
  head_sha: z.string(),
  conclusion: z.string().nullable(),
  updated_at: z.string(),
  url: z.string(),
  pull_requests: z.array(z.object({ number })),
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

/** Pure mapping after authentication. Never fetches payload links or guesses missing PR mappings. */
export function githubEvents(
  type: string,
  input: unknown,
  deliveryId: string,
  options: z.infer<typeof githubOptions>,
  logger: VelaLogger,
): ChannelEvent[] {
  const actions: Record<string, string> = {
    check_suite: 'completed',
    pull_request_review: 'submitted',
    issue_comment: 'created',
    pull_request: 'closed',
  }
  if (!(type in actions)) return []
  const raw = record.parse(input)
  if (raw.action !== actions[type]) return []
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
    pr: number,
    summary: string,
    details: string,
    final?: boolean,
  ): ChannelEvent => ({
    source: 'github',
    key: `github:${repo}#pr/${pr}`,
    deliveryId,
    summary: bounded(summary, 500),
    details: bounded(details, 8192),
    ...(final ? { final: true } : {}),
  })
  if (type === 'check_suite') {
    const check = suite.parse(raw.check_suite)
    if (!check.app.slug || !options.apps.includes(check.app.slug)) return []
    if (!check.pull_requests.length) {
      logger.info('[events] GitHub check_suite has no PR mapping; dropped')
      return []
    }
    return [...new Set(check.pull_requests.map((pr) => pr.number))].map((pr) =>
      event(
        pr,
        `GitHub check suite ${check.app.slug} completed: ${check.conclusion ?? 'unknown'} (SHA ${check.head_sha})`,
        `Repository: ${repo}\nPR: #${pr}\nSuite: ${check.app.slug}\nSHA: ${check.head_sha}\nConclusion: ${check.conclusion ?? 'unknown'}\nUpdated: ${check.updated_at}\n${check.url}`,
      ),
    )
  }
  if (type === 'issue_comment') {
    const issue = z
      .object({ number, pull_request: record.optional() })
      .parse(raw.issue)
    if (!issue.pull_request) return []
    const comment = content.parse(raw.comment)
    if (ownBody(comment.body ?? '')) return []
    return [
      event(
        issue.number,
        `GitHub PR #${issue.number}: comment by ${comment.user.login}`,
        `Author: ${comment.user.login}\n${comment.html_url}\n${comment.body ?? ''}`,
      ),
    ]
  }
  if (type === 'pull_request_review') {
    const target = z.object({ number }).parse(raw.pull_request)
    const item = review.parse(raw.review)
    if (ownBody(item.body ?? '')) return []
    return [
      event(
        target.number,
        `GitHub PR #${target.number}: ${item.user.login} submitted review (${item.state})`,
        `Reviewer: ${item.user.login}\nState: ${item.state}\nCommit SHA: ${item.commit_id}\n${item.html_url}\n${item.body ?? ''}`,
      ),
    ]
  }
  const target = pr.parse(raw.pull_request)
  const state = target.merged ? 'merged' : 'closed without merge'
  return [
    event(
      target.number,
      `GitHub PR #${target.number} ${state}: ${target.title}`,
      `Author: ${target.user.login}\nState: ${state}\nHead SHA: ${target.head.sha}\n${target.html_url}`,
      true,
    ),
  ]
}
