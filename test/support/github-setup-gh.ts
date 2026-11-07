// Stateful, local-only gh executable fixture. It never performs network requests.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const path = process.env.GH_SETUP_STATE!
const state = JSON.parse(readFileSync(path, 'utf8'))
const args = process.argv.slice(2)
const input = readFileSync(0, 'utf8')
state.calls.push({
  args,
  input,
  settings: JSON.parse(
    readFileSync(join(process.env.VELA_DIR!, 'settings.json'), 'utf8'),
  ),
})
const save = () => writeFileSync(path, JSON.stringify(state))
const fail = (message: string) => {
  save()
  process.stderr.write(message)
  process.exit(1)
}
if (args[0] === 'auth') {
  if (state.auth === false) fail('not logged in')
  save()
  process.exit(0)
}
const endpoint = args.find((value) => /^\/?repos\//.test(value)) ?? ''
const match = /^\/?repos\/([^/]+\/[^/]+)\/hooks(?:\/(\d+))?(?:\?.*)?$/.exec(
  endpoint,
)
if (!match) fail('unexpected endpoint')
const repo = match![1]!
if (state.fail?.includes(repo))
  fail('HTTP 403: repository administration permission required')
const methodIndex =
  args.indexOf('--method') >= 0 ? args.indexOf('--method') : args.indexOf('-X')
const method = methodIndex >= 0 ? args[methodIndex + 1] : 'GET'
state.hooks[repo] ??= []
const hooks = state.hooks[repo]
if (method === 'GET') {
  const pages = []
  for (let i = 0; i < hooks.length; i += 100)
    pages.push(hooks.slice(i, i + 100))
  if (!pages.length) pages.push([])
  const shown = args.includes('--paginate') ? pages : pages.slice(0, 1)
  save()
  process.stdout.write(
    args.includes('--slurp')
      ? JSON.stringify(shown)
      : shown.map((page) => JSON.stringify(page)).join('\n'),
  )
  process.exit(0)
}
const body = JSON.parse(input)
if (state.echoSecret)
  fail(
    `raw: ${body.config.secret}; encoded: ${JSON.stringify(body.config.secret)}`,
  )
if (method === 'POST')
  hooks.push({
    id:
      hooks.reduce(
        (max: number, hook: { id: number }) => Math.max(max, hook.id),
        0,
      ) + 1,
    ...body,
  })
else if (method === 'PATCH') {
  const index = hooks.findIndex(
    (hook: { id: number }) => hook.id === Number(match![2]),
  )
  if (index < 0) fail('HTTP 404')
  hooks[index] = { ...hooks[index], ...body }
} else fail('unexpected method')
if (state.lost && method === 'POST') {
  state.lost = false
  fail('connection lost after request')
}
save()
process.stdout.write('{}')
