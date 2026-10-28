import { expect, test } from 'bun:test'

const packages = ['core', 'channels', 'mcp', 'rag', 'lark', 'vela'].map(
  (key) => ({
    key,
    name: '@glows777/vela' + (key === 'vela' ? '' : '-' + key),
    version: '0.4.0',
    dependencies:
      key === 'core' ? {} : { '@glows777/vela-core': 'workspace:*' },
  }),
)
test('lockstep publication skips existing matching artifacts and publishes dependency order', async () => {
  const { publishMissing } = await import('../../scripts/workspaces.ts')
  const existing = new Map<string, { gitHead: string }>([
    [packages[0]!.name, { gitHead: 'commit' }],
  ])
  const published: string[] = []
  await publishMissing(packages, 'commit', {
    lookup: async (name) => existing.get(name),
    publish: async (pkg) => {
      published.push(pkg.key)
      existing.set(pkg.name, { gitHead: 'commit' })
    },
  })
  expect(published).toEqual(['channels', 'mcp', 'rag', 'lark', 'vela'])
  expect(existing.size).toBe(6)
})
test('registry errors never become absent versions and conflicting artifacts stop publication', async () => {
  const { publishMissing } = await import('../../scripts/workspaces.ts')
  const published: string[] = []
  await expect(
    publishMissing(packages, 'commit', {
      lookup: async () => {
        throw new Error('registry authentication failed')
      },
      publish: async (pkg) => {
        published.push(pkg.key)
      },
    }),
  ).rejects.toThrow('authentication')
  await expect(
    publishMissing(packages, 'commit', {
      lookup: async () => ({ gitHead: 'different-commit' }),
      publish: async (pkg) => {
        published.push(pkg.key)
      },
    }),
  ).rejects.toThrow('different')
  expect(published).toEqual([])
})
test('a partial publish can resume only missing packages from the same release commit', async () => {
  const { publishMissing } = await import('../../scripts/workspaces.ts')
  const existing = new Map<string, { gitHead: string }>()
  const published: string[] = []
  let fail = true
  const io = {
    lookup: async (name: string) => existing.get(name),
    publish: async (pkg: { name: string; key: string }) => {
      if (pkg.key === 'rag' && fail) throw new Error('publish interrupted')
      published.push(pkg.key)
      existing.set(pkg.name, { gitHead: 'commit' })
    },
  }
  await expect(publishMissing(packages, 'commit', io)).rejects.toThrow(
    'interrupted',
  )
  fail = false
  await publishMissing(packages, 'commit', io)
  expect(published).toEqual(['core', 'channels', 'mcp', 'rag', 'lark', 'vela'])
})

test('release preparation installs Bun before running the workspace status command', async () => {
  const { parse } = await import('yaml')
  const workflow = parse(
    await Bun.file(
      new URL('../../.github/workflows/release.yml', import.meta.url),
    ).text(),
  )
  const steps: { uses?: string; run?: string }[] = workflow.jobs.prepare.steps
  const status = steps.findIndex((step) =>
    step.run?.includes('bun scripts/release.ts --status'),
  )
  expect(status).toBeGreaterThan(0)
  expect(
    steps
      .slice(0, status)
      .some((step) => step.uses?.startsWith('oven-sh/setup-bun@')),
  ).toBe(true)
})
