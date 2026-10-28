import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const TOKEN_LEAD = /^[[({]+/
const TOKEN_TRAIL = /[.,;!?)\]]+$/

const ROUTES = [
  {
    id: 'forge',
    sink: 'grok',
    labels: ['to:forge', 'Forge'],
    tokens: ['to:forge', '@forge'],
  },
  {
    id: 'taste',
    sink: 'grok',
    labels: ['Taste'],
    tokens: ['Taste'],
  },
  {
    id: 'vela',
    sink: 'lark',
    labels: ['to:vela'],
    tokens: ['to:vela', '@vela'],
  },
]

const EVENT_ACTIONS = {
  issues: ['labeled', 'assigned'],
  pull_request: [
    'opened',
    'ready_for_review',
    'reopened',
    'synchronize',
    'labeled',
  ],
  pull_request_review: ['submitted'],
  issue_comment: ['created'],
  pull_request_review_comment: ['created'],
}

const DEBOUNCE_WINDOW_MS = 90_000
const BOT_EXACT = new Set(['dependabot', 'cursoragent', 'chatgpt-codex'])
const BOT_PREFIXES = ['chatgpt-codex', 'claude']

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isBotLogin(login) {
  const normalized = login.toLowerCase()
  if (normalized.endsWith('[bot]')) return true
  if (BOT_EXACT.has(normalized)) return true
  return BOT_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

function labelNames(item) {
  if (!Array.isArray(item.labels)) return []
  const names = []
  for (const label of item.labels) {
    if (isObject(label) && typeof label.name === 'string')
      names.push(label.name)
  }
  return names
}

function readItem(raw) {
  if (!isObject(raw)) return null
  if (typeof raw.number !== 'number') return null
  if (typeof raw.title !== 'string' || raw.title.length === 0) return null
  if (typeof raw.html_url !== 'string' || raw.html_url.length === 0) return null
  if (raw.state !== 'open' && raw.state !== 'closed') return null
  if (typeof raw.updated_at !== 'string') return null
  return {
    number: raw.number,
    title: raw.title,
    htmlUrl: raw.html_url,
    labels: labelNames(raw),
    state: raw.state,
    merged: raw.merged === true,
    updatedAt: raw.updated_at,
  }
}

function parseEvent(eventName, payload) {
  if (!isObject(payload)) return null
  const actions = EVENT_ACTIONS[eventName]
  if (!actions) return null
  const action = payload.action
  if (typeof action !== 'string' || !actions.includes(action)) return null
  const sender = isObject(payload.sender) ? payload.sender.login : undefined
  const senderLogin = typeof sender === 'string' ? sender : ''

  if (eventName === 'issues') {
    const item = readItem(payload.issue)
    if (!item) return null
    const event = { kind: 'issues', action, item, sender: senderLogin }
    if (action === 'labeled') {
      event.addedLabel = isObject(payload.label)
        ? payload.label.name
        : undefined
    }
    if (action === 'assigned') {
      event.assignee = isObject(payload.assignee)
        ? payload.assignee.login
        : undefined
    }
    return event
  }

  if (eventName === 'pull_request') {
    const item = readItem(payload.pull_request)
    if (!item) return null
    const event = { kind: 'pull_request', action, item, sender: senderLogin }
    if (action === 'labeled') {
      event.addedLabel = isObject(payload.label)
        ? payload.label.name
        : undefined
    }
    if (action === 'synchronize') {
      const head = isObject(payload.pull_request.head)
        ? payload.pull_request.head
        : null
      event.headSha =
        head && typeof head.sha === 'string' ? head.sha : undefined
    }
    return event
  }

  if (eventName === 'pull_request_review') {
    const item = readItem(payload.pull_request)
    if (!item || !isObject(payload.review)) return null
    if (typeof payload.review.id !== 'number') return null
    if (typeof payload.review.submitted_at !== 'string') return null
    return {
      kind: 'pull_request_review',
      action,
      item,
      sender: senderLogin,
      reviewId: payload.review.id,
      submittedAt: payload.review.submitted_at,
    }
  }

  if (
    eventName === 'issue_comment' ||
    eventName === 'pull_request_review_comment'
  ) {
    const rawItem =
      eventName === 'issue_comment' ? payload.issue : payload.pull_request
    const item = readItem(rawItem)
    if (!item || !isObject(payload.comment)) return null
    if (typeof payload.comment.id !== 'number') return null
    if (typeof payload.comment.body !== 'string') return null
    if (typeof payload.comment.created_at !== 'string') return null
    return {
      kind: eventName,
      action,
      item,
      sender: senderLogin,
      commentId: payload.comment.id,
      body: payload.comment.body,
      createdAt: payload.comment.created_at,
    }
  }

  return null
}

function eventInstant(event) {
  if (
    event.kind === 'issue_comment' ||
    event.kind === 'pull_request_review_comment'
  ) {
    return event.createdAt
  }
  if (event.kind === 'pull_request_review') return event.submittedAt
  return event.item.updatedAt
}

function bucketOf(instant) {
  const ms = Date.parse(instant)
  if (Number.isNaN(ms)) return undefined
  return Math.floor(ms / DEBOUNCE_WINDOW_MS)
}

function discriminator(event) {
  if (
    event.kind === 'issue_comment' ||
    event.kind === 'pull_request_review_comment'
  ) {
    return `c/${event.commentId}`
  }
  if (event.kind === 'pull_request_review') return `r/${event.reviewId}`
  if (event.action === 'synchronize') {
    return event.headSha ? `s/${event.headSha}` : undefined
  }
  if (event.action === 'labeled') {
    return typeof event.addedLabel === 'string'
      ? `l/${encodeURIComponent(event.addedLabel)}@${event.item.updatedAt}`
      : undefined
  }
  if (event.action === 'assigned') {
    return typeof event.assignee === 'string'
      ? `a/${encodeURIComponent(event.assignee)}@${event.item.updatedAt}`
      : undefined
  }
  return `t/${event.action}@${event.item.updatedAt}`
}

function deliveryId(identity) {
  return [
    'v1',
    encodeURIComponent(identity.repo),
    identity.route,
    identity.event,
    identity.action,
    String(identity.number),
    identity.discriminator,
  ].join('/')
}

function tokenWords(body) {
  const words = new Set()
  for (const raw of body.split(/\s+/)) {
    const word = raw.replace(TOKEN_LEAD, '').replace(TOKEN_TRAIL, '')
    if (word) words.add(word)
  }
  return words
}

function selectionsFor(event) {
  const selected = new Map()
  if (
    event.kind === 'issue_comment' ||
    event.kind === 'pull_request_review_comment'
  ) {
    const words = tokenWords(event.body)
    for (const route of ROUTES) {
      for (const token of route.tokens) {
        if (!words.has(token)) continue
        selected.set(route.id, { via: 'token', token })
        break
      }
    }
    return selected
  }
  const labels = new Set(event.item.labels)
  for (const route of ROUTES) {
    for (const label of route.labels) {
      if (!labels.has(label)) continue
      selected.set(route.id, { via: 'label', label })
      break
    }
  }
  return selected
}

function reasonOf(event, selection) {
  if (selection.via === 'token') return `token:${selection.token}`
  if (event.action === 'assigned') return 'assigned'
  if (event.action === 'submitted') return 'review'
  if (event.action === 'labeled') return `label:${selection.label}`
  return event.action
}

function oneLine(title) {
  return title.replace(/[\r\n]+/g, ' ')
}

function grokBody(event, route, id, reason) {
  return {
    delivery_id: id,
    event: event.kind,
    action: event.action,
    number: event.item.number,
    title: event.item.title,
    html_url: event.item.htmlUrl,
    labels: event.item.labels,
    actor_login: event.sender,
    route,
    reason,
  }
}

function larkBody(event, id) {
  const text = [
    `Look at #${event.item.number}`,
    oneLine(event.item.title),
    event.item.htmlUrl,
    `delivery_id: ${id}`,
  ].join('\n')
  return { msg_type: 'text', content: { text } }
}

function decide(input) {
  const event = parseEvent(input.eventName, input.payload)
  if (!event) {
    return {
      posts: [],
      skips: [{ code: 'unhandled-event', detail: String(input.eventName) }],
    }
  }
  if (!event.sender || isBotLogin(event.sender)) {
    return {
      posts: [],
      skips: [{ code: 'bot', detail: event.sender || 'missing sender' }],
    }
  }
  if (event.item.merged || event.item.state === 'closed') {
    return { posts: [], skips: [{ code: 'closed', detail: event.item.state }] }
  }

  const selections = selectionsFor(event)
  if (selections.size === 0) {
    return { posts: [], skips: [{ code: 'no-route', detail: event.action }] }
  }

  const repo = isObject(input.payload.repository)
    ? input.payload.repository.full_name
    : undefined
  const instant = eventInstant(event)
  const bucket = bucketOf(instant)
  const stamp = discriminator(event)
  if (
    typeof repo !== 'string' ||
    repo.length === 0 ||
    bucket === undefined ||
    !stamp
  ) {
    return { posts: [], skips: [{ code: 'unparsed', detail: 'missing field' }] }
  }

  const posts = []
  const skips = []
  for (const route of ROUTES) {
    const selection = selections.get(route.id)
    if (!selection) continue
    const reason = reasonOf(event, selection)
    const id = deliveryId({
      repo,
      event: event.kind,
      action: event.action,
      number: event.item.number,
      route: route.id,
      discriminator: stamp,
    })
    if (input.lastBuckets[route.id] === bucket) {
      skips.push({
        code: 'debounced',
        route: route.id,
        deliveryId: id,
        detail: `bucket ${bucket}`,
      })
      continue
    }
    const body =
      route.sink === 'lark'
        ? larkBody(event, id)
        : grokBody(event, route.id, id, reason)
    posts.push({
      sink: route.sink,
      route: route.id,
      deliveryId: id,
      bucket,
      body,
    })
  }
  return { posts, skips }
}

function readBuckets(path) {
  if (!path) return { buckets: {}, unreadable: false }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (!isObject(data)) return { buckets: {}, unreadable: true }
    const buckets = {}
    for (const route of ROUTES) {
      if (Number.isFinite(data[route.id])) buckets[route.id] = data[route.id]
    }
    return { buckets, unreadable: false }
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT')
      return { buckets: {}, unreadable: false }
    return { buckets: {}, unreadable: true }
  }
}

function main() {
  const eventName = process.env.WAKE_EVENT_NAME
  const eventPath = process.env.WAKE_EVENT_PATH
  if (!eventName || !eventPath) {
    process.stderr.write('WAKE_EVENT_NAME and WAKE_EVENT_PATH are required\n')
    process.exit(1)
  }
  let payload
  try {
    payload = JSON.parse(readFileSync(eventPath, 'utf8'))
  } catch {
    process.stderr.write('event payload is unreadable\n')
    process.exit(1)
  }
  const state = readBuckets(process.env.WAKE_STATE_PATH)
  if (state.unreadable) {
    const plan = {
      posts: [],
      skips: [{ code: 'state-unreadable', detail: 'buckets.json' }],
    }
    process.stdout.write(`${JSON.stringify(plan)}\n`)
    process.stderr.write('buckets.json is unreadable\n')
    process.exit(1)
  }
  const plan = decide({
    eventName,
    payload,
    lastBuckets: state.buckets,
  })
  process.stdout.write(`${JSON.stringify(plan)}\n`)
}

const isCli =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
if (isCli) main()
