# Wake an agent from GitHub

GitHub is the source of truth. `.github/workflows/wake-route.yml` is a thin filter. It POSTs to a Grok Bot webhook when a Grok route label is present, or when a comment contains a Grok route token. Vela uses its own GitHub webhook integration outside this workflow; Leader and Friday are not woken by this workflow.

## Routing table

| Signal | Wake |
|---|---|
| `to:forge` label, or `Forge` label | Grok Bot webhook routine, then Forge |
| `Taste` label | Same Grok webhook, JSON field `route` set to `taste` |
| `to:vela` / `@vela` | Handled outside this workflow (Vela's own GitHub webhook) |
| Leader, Friday (Codex) | Out of scope for this workflow |

A bare `bug` label wakes nobody. Forge wakes only on the `Forge` label, the `to:forge` label, or the comment tokens `to:forge` and `@forge`. The word `bug` does not select a route.

Comment tokens are whole words, case sensitive. The tokens are `to:forge`, `@forge`, and `Taste`. `to:forge.` matches, because the trailing period is punctuation. `Tasteful`, `to:forge-bot`, and `email@forge.com` do not match.

These rows are notes only. The workflow has no code for them.

| Signal | Later wake |
|---|---|
| `research` or `competitor` | Prism, through a Grok webhook, not in this cut |
| Coding completion | Taste, to re-verify, not in this cut |

## Events that can wake

- `issues` with action `labeled` or `assigned`
- `pull_request` with action `opened`, `ready_for_review`, `reopened`, `synchronize`, or `labeled`
- `pull_request_review` with action `submitted`, and only when a route label is already on the pull request
- `issue_comment` and `pull_request_review_comment` with action `created`, and only when the body contains a route token

`assigned` wakes only the route labels already on the issue. Assignment alone does not pick a route. A comment wakes the tokens in that body. It does not also wake every label on the thread.

Removing a label does not wake. `review_requested`, ordinary comments, pushes, statuses, and check runs are not triggers. A closed issue does not wake. A closed or merged pull request does not wake.

The workflow drops a bot actor. A login that ends with `[bot]` is a bot. So are the exact logins `dependabot`, `cursoragent`, and `chatgpt-codex`, and any login that starts with `chatgpt-codex` or `claude`.

## Set the secrets

Liam creates the webhook. A developer applies a label, or writes a whole token in a comment.

### Grok Bot

1. In Grok Bot, create the Forge webhook routine.
2. On the routine panel, copy the URL and the sender key.
3. In the GitHub repository, open Settings, then Secrets and variables, then Actions.
4. Create `WAKE_GROK_FORGE_WEBHOOK_URL` with the URL.
5. Create `WAKE_GROK_FORGE_WEBHOOK_KEY` with the sender key.

The workflow sends `Authorization: Bearer` and that key. It does not add a second signature. Taste uses the same URL and the same key. The JSON body sets `route` to `taste`. Do not create a Taste secret for v1.

The Grok routine must not post a GitHub comment that contains `to:forge`, `Taste`, or `@forge`. A comment with one of those tokens starts this workflow again.

### Labels

Create the labels `to:forge`, `Forge`, and `Taste` if the repository does not already have them.

## What the receiver gets

A Grok POST is JSON.

```json
{
  "delivery_id": "v1/acme%2Fvela/forge/issues/labeled/1284/l/to%3Aforge@2026-10-26T15:04:05Z",
  "event": "issues",
  "action": "labeled",
  "number": 1284,
  "title": "Debounce wake posts",
  "html_url": "https://github.com/acme/vela/issues/1284",
  "labels": ["to:forge"],
  "actor_login": "liam",
  "route": "forge",
  "reason": "label:to:forge"
}
```

GitHub Actions does not pass the `X-GitHub-Delivery` header into the job. `delivery_id` is built from the repository, the route, the event, the action, the number, and a stamp taken from the payload. A re-run of the same event keeps the same id. A new comment, label action, review, or head SHA changes it. The receiver must do nothing when that id arrives again.

## Debounce

The window is 90 seconds, per issue or pull request number, event name, and route. The first event in a bucket POSTs. A later event in that same bucket for the same route does not. `2026-10-26T15:04:29Z` and `2026-10-26T15:04:30Z` fall in different buckets, so both POST. A cache restore that misses a save just written can POST two different events from one bucket. A repeated `delivery_id` is still a no-op for the receiver.

One job writes the bucket file for that number and event name, with `cancel-in-progress` set to false. `queue: max` keeps up to 100 pending runs instead of replacing a queued route mention when a later ordinary comment arrives. GitHub cancels additional arrivals when that queue is full. Cancelling a job that already started `curl` would send a second id.

A missing secret skips that route with a notice. The job fails when a POST fails after its secret was present. A corrupt bucket file fails the job and sends nothing.

## Try the filter locally

The CLI prints a plan. It does not POST.

```sh
WAKE_EVENT_NAME=issues WAKE_EVENT_PATH=./event.json node .github/wake/decide.mjs
```

`test/unit/wake-route.test.ts` locks the plan and models the pending-comment queue using GitHub's documented semantics. `bun test test/unit/wake-route.test.ts test/unit/wake-post.test.ts` also runs the actual workflow POST step against local fake HTTP endpoints, checking saved buckets, missing secrets, and Grok route bodies. It sends no real provider messages.
