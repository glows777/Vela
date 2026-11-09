import { expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createFauxModel,
  fauxText,
  fauxToolCall,
} from '@glows777/vela-core/testing'
import { ToolResultStore } from '../../packages/core/src/session/tool-results.ts'
import { createCoreTools } from '../../packages/core/src/tools/index.ts'
import type { ToolContext } from '../../packages/core/src/tools/registry.ts'
import { requestReservation } from './budget.ts'
import { type Evidence, grade } from './graders.ts'
import { MemoryIsolation } from './isolation.ts'
import { options } from './run.ts'
import { command, runAttempt, type WorkerConfig } from './worker.ts'

const workspace =
  '/tmp/.vela-eval/run/attempt/data/channels/lark-oc_group/workspace'
const runtime =
  process.env.VELA_EVAL_TEST_RUNTIME ?? resolve(import.meta.dir, '../..')

test('G7/G8 keep the portable default and require an explicit isolation profile', () => {
  expect(options(['--only', 'G7,G8']).isolation).toBe('legacy')
  expect(options(['--isolation', 'workspace-v1']).isolation).toBe(
    'workspace-v1',
  )
  expect(options(['--isolation', 'legacy']).isolation).toBe('legacy')
})

const evidence = (command: string): Evidence => ({
  answers: ['kestrel'],
  calls: [
    {
      name: 'memory',
      args: { action: 'read', filename: 'project_server.md' },
      phase: 1,
      sessionId: 'lark-oc_group-g8_recall',
      success: true,
      output: 'The server is called kestrel.',
    },
    {
      name: 'bash',
      args: { command },
      phase: 1,
      sessionId: 'lark-oc_group-g8_recall',
      success: true,
    },
  ],
  deliveries: [{ scope: 'topic', topicRootId: 'g8_recall', text: 'kestrel' }],
  topics: [],
  compactions: [],
  files: {},
  changed: [],
  validation: {},
  memoryEntries: [{ name: 'server', content: 'kestrel' }],
  recallPaths: { workspace, artifactDir: '/tmp/.vela-eval/run/attempt' },
})

test('absolute and relative references to the same legitimate workspace have the same grade', () => {
  expect(grade('G8', evidence(`ls -la ${workspace}`))).toEqual(
    grade('G8', evidence('ls -la .')),
  )
})

test('a raw sessions directory inside the workspace remains forbidden', () => {
  expect(
    grade('G8', evidence(`cat ${workspace}/sessions/store.jsonl`))[1]!.pass,
  ).toBe(false)
})

test('current tool-output paging is permitted but is not a memory source; prior-topic output remains forbidden', () => {
  const resultsDir =
    '/tmp/state/data/sessions/lark-oc_group-g8_recall/tool-results'
  const e = evidence(`cat ${resultsDir}/long.txt`)
  e.isolation = {
    profile: 'workspace-v1',
    preflight: 'passed',
    phases: {
      task: [],
      recall: [
        {
          name: 'bash',
          args: {},
          confined: true,
          sessionId: 'lark-oc_group-g8_recall',
          resultsDir,
        },
      ],
    },
  }
  expect(grade('G8', e)[1]!.pass).toBe(true)
  e.calls = [
    {
      name: 'read_file',
      args: { path: `${resultsDir}/long.txt` },
      phase: 1,
      sessionId: 'lark-oc_group-g8_recall',
      success: true,
      output: 'kestrel',
    },
  ]
  expect(grade('G8', e)[1]!.pass).toBe(false)
  e.calls = evidence(
    `cat ${resultsDir.replace('g8_recall', 'g8_store')}/long.txt`,
  ).calls
  expect(grade('G8', e)[1]!.pass).toBe(false)
})

// Kernel isolation is opt-in, requires Linux/bubblewrap, and never calls a provider.
test.skipIf(process.env.VELA_EVAL_SANDBOX_TESTS !== '1')(
  'isolated worker denies artifact reads in both phases while preserving valid memory',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'eval-boundary-'))
    try {
      const cwd = join(root, 'work')
      const artifactDir = join(root, 'artifacts')
      await mkdir(artifactDir)
      await command(root, ['git', 'init', '-q', cwd])
      await command(cwd, [
        'git',
        '-c',
        'user.name=Eval',
        '-c',
        'user.email=eval@localhost',
        '-c',
        'commit.gpgSign=false',
        'commit',
        '--allow-empty',
        '-qm',
        'Fixture',
      ])
      const canary = join(artifactDir, 'private.txt')
      await Bun.write(canary, 'PRIVATE_EVALUATION_CANARY')
      const model = createFauxModel({
        responses: [
          fauxToolCall('read_file', { path: canary }),
          () => {
            return fauxToolCall('memory', {
              action: 'save',
              name: 'server',
              type: 'project',
              description: 'Current server name',
              content: 'The staging server is called kestrel.',
            })
          },
          fauxText(
            'The kestrel deploy is delayed to 22:00.\nOn-call, use the new time.',
          ),
          fauxToolCall('bash', {
            command: `cat '${canary}'; cat /runtime/scripts/eval/scenarios.ts`,
          }),
          () => {
            return fauxToolCall('memory', {
              action: 'read',
              filename: 'project_server.md',
            })
          },
          fauxText('kestrel'),
        ],
      })
      const config: WorkerConfig & { isolation: 'workspace-v1' } = {
        runtime,
        cwd,
        artifactDir,
        scenario: 'G8',
        arm: 'new',
        run: 1,
        attempt: 1,
        thinking: 'off',
        isolation: 'workspace-v1',
      }
      const result = await runAttempt(config, undefined, model)
      expect(result.evidence?.isolation).toMatchObject({ preflight: 'passed' })
      expect(result.status).not.toBe('error')
      expect(model.calls[1]!.toolResults[0]!.output).not.toContain(
        'PRIVATE_EVALUATION_CANARY',
      )
      expect(model.calls[4]!.toolResults[0]!.output).not.toContain(
        'PRIVATE_EVALUATION_CANARY',
      )
      expect(result.evidence?.memoryEntries).toEqual([
        { name: 'server', content: 'The staging server is called kestrel.' },
      ])
      expect(result.evidence).toHaveProperty(
        'isolation.profile',
        'workspace-v1',
      )
      expect(result.evidence).toHaveProperty('isolation.preflight', 'passed')
      expect(result.evidence).toHaveProperty('isolation.phases.task')
      expect(result.evidence).toHaveProperty('isolation.phases.recall')
      expect(model.calls[0]!.system).not.toContain('.vela-eval')
      expect(model.calls[0]!.tools).toContain('bash')
      expect(model.calls[0]!.tools).toContain('read_file')
      expect(JSON.stringify(model.calls[0]!.prompt)).not.toContain('g8_store')
      expect(model.pending()).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.env.VELA_EVAL_SANDBOX_TESTS !== '1')(
  'spilled tool output can be paged by its own session but not by the recall topic',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'eval-spill-'))
    try {
      const cwd = join(root, 'work')
      const artifactDir = join(root, 'artifacts')
      await command(root, ['git', 'init', '-q', cwd])
      await command(cwd, [
        'git',
        '-c',
        'user.name=Eval',
        '-c',
        'user.email=eval@localhost',
        '-c',
        'commit.gpgSign=false',
        'commit',
        '--allow-empty',
        '-qm',
        'Fixture',
      ])
      let taskOutput = ''
      const model = createFauxModel({
        responses: [
          fauxToolCall('bash', {
            command: 'for n in $(seq 1 3000); do echo PRIVATE_TASK_SPILL; done',
          }),
          (req) => {
            taskOutput = req.toolResults[0]!.output.match(
              /Full output:\s*([^\]\n]+)/,
            )![1]!
            return fauxToolCall('read_file', { path: taskOutput, limit: 1 })
          },
          fauxText('The deploy is delayed to 22:00.\nUse the new time.'),
          () => fauxToolCall('read_file', { path: taskOutput, limit: 1 }),
          () => fauxToolCall('bash', { command: `cat '${taskOutput}'` }),
          fauxText('I do not know.'),
        ],
      })
      const result = await runAttempt(
        {
          runtime,
          cwd,
          artifactDir,
          scenario: 'G8',
          arm: 'new',
          run: 1,
          attempt: 1,
          thinking: 'off',
          isolation: 'workspace-v1',
        },
        undefined,
        model,
      )
      expect(result.status).not.toBe('error')
      expect(model.calls[2]!.toolResults[0]!.output).toContain(
        'PRIVATE_TASK_SPILL',
      )
      expect(model.calls[4]!.toolResults[0]!.output).not.toContain(
        'PRIVATE_TASK_SPILL',
      )
      expect(model.calls[5]!.toolResults[0]!.output).not.toContain(
        'PRIVATE_TASK_SPILL',
      )
      expect(model.pending()).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.env.VELA_EVAL_SANDBOX_TESTS !== '1').each(
  [
    { budgetUsd: 0.1, missingSandbox: false, pass: false, dream: false },
    { budgetUsd: 0.5, missingSandbox: true, pass: false, dream: false },
    { budgetUsd: 0.5, missingSandbox: false, pass: true, dream: false },
    { budgetUsd: 0.5, missingSandbox: false, pass: true, dream: true },
  ].filter((item) => !process.env.VELA_EVAL_TEST_RUNTIME || !item.dream),
)(
  'clean worker preserves the exit bar and refuses unaffordable/unconfined requests: %j',
  async ({ budgetUsd, missingSandbox, pass, dream }) => {
    const root = await mkdtemp(join(tmpdir(), 'eval-admission-'))
    let spy: ReturnType<typeof spyOn> | undefined
    try {
      const cwd = join(root, 'work')
      const artifactDir = join(root, 'artifacts')
      await command(root, ['git', 'init', '-q', cwd])
      await command(cwd, [
        'git',
        '-c',
        'user.name=Eval',
        '-c',
        'user.email=eval@localhost',
        '-c',
        'commit.gpgSign=false',
        'commit',
        '--allow-empty',
        '-qm',
        'Fixture',
      ])
      const model = createFauxModel({
        generate: dream
          ? [fauxText(JSON.stringify({ ops: [], report: 'No changes.' }))]
          : undefined,
        responses: [
          () => {
            const usage = JSON.parse(
              readFileSync(join(artifactDir, 'usage.json'), 'utf8'),
            )
            expect(usage.unknown).toBe(1)
            expect(usage.costUpperBound).toBe(requestReservation)
            return fauxToolCall('memory', {
              action: 'save',
              name: 'server',
              description: 'Current server',
              type: 'project',
              content: 'The server is called kestrel.',
            })
          },
          fauxText(
            'The kestrel deploy is delayed to 22:00.\nUse the new time.',
          ),
          fauxToolCall('memory', {
            action: 'read',
            filename: 'project_server.md',
          }),
          fauxText('kestrel'),
        ],
      })
      if (missingSandbox) {
        const which = Bun.which
        spy = spyOn(Bun, 'which').mockImplementation((name, options) =>
          name === 'bwrap' ? null : which(name, options),
        )
      }
      const result = await runAttempt(
        {
          runtime,
          cwd,
          artifactDir,
          scenario: 'G8',
          arm: 'new',
          run: 1,
          attempt: 1,
          thinking: 'off',
          isolation: 'workspace-v1',
          budgetUsd,
          dream,
        },
        undefined,
        model,
      )
      if (pass) {
        expect(result.status).toBe('pass')
        expect(result.checks).toEqual([
          { name: 'store', pass: true },
          { name: 'recall', pass: true },
        ])
        expect(result.usage.unknown).toBe(0)
        expect(result.usage.costUpperBound).toBeCloseTo(result.usage.cost, 9)
        const requests = (
          await Bun.file(join(artifactDir, 'requests.jsonl')).text()
        )
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(requests.map((request) => request.phase)).toEqual(
          dream ? [0, 0, 0, 1, 1] : [0, 0, 1, 1],
        )
        expect(
          requests.filter((request) => request.kind === 'summary'),
        ).toHaveLength(dream ? 1 : 0)
        expect(
          requests.every((request) => request.maxOutputTokens === 8192),
        ).toBe(true)
        expect(model.pending()).toBe(0)
      } else {
        expect(result.status).toBe('error')
        expect(result.usage.requests).toBe(0)
        expect(model.calls).toHaveLength(0)
        if (missingSandbox)
          expect(result.evidence?.isolation?.preflight).toBe('failed')
        else expect(result.reason).toBe('Evaluation budget exhausted')
      }
    } finally {
      spy?.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(
  process.env.VELA_EVAL_SANDBOX_TESTS !== '1' ||
    !!process.env.VELA_EVAL_TEST_RUNTIME,
)(
  'all native disk tools retain workspace access without exposing host artifacts, symlinks or dream inboxes',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'eval-tools-'))
    try {
      const workspace = join(root, 'data/group/workspace')
      const groupMemory = join(root, 'data/group/memory')
      const artifactDir = join(root, 'evidence')
      await mkdir(workspace, { recursive: true })
      await mkdir(join(groupMemory, '.dream'), { recursive: true })
      await mkdir(artifactDir)
      await writeFile(join(artifactDir, 'private.txt'), 'PRIVATE_HOST_DATA')
      await writeFile(join(groupMemory, 'project_note.md'), 'APPROVED_MEMORY')
      await writeFile(join(groupMemory, '.dream/inbox.jsonl'), 'PRIVATE_INBOX')
      await symlink(artifactDir, join(workspace, 'escape'))
      const tools = createCoreTools({ cwd: workspace })
      const boundary = new MemoryIsolation(
        runtime,
        workspace,
        join(root, 'data'),
        artifactDir,
      )
      await boundary.install({ getAllTools: () => tools }, () => 0)
      const context = {
        registry: {} as ToolContext['registry'],
        results: new ToolResultStore(join(workspace, '.results')),
      }
      const run = (name: string, input: unknown, ctx = context) =>
        tools.find((tool) => tool.name === name)!.execute(input, ctx)
      await run('write_file', { path: 'a.txt', content: 'visible text' })
      expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe(
        'visible text',
      )
      expect(
        JSON.stringify(await run('read_file', { path: 'a.txt' })),
      ).toContain('visible text')
      await run('edit_file', {
        path: 'a.txt',
        edits: [{ oldText: 'visible', newText: 'updated' }],
      })
      expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe(
        'updated text',
      )
      await expect(
        run(
          'write_file',
          { path: 'a.txt', content: 'unread overwrite' },
          { ...context, registry: {} as ToolContext['registry'] },
        ),
      ).rejects.toThrow('has not read')
      await run('bash', { command: 'printf external > a.txt' })
      await expect(
        run('write_file', { path: 'a.txt', content: 'stale overwrite' }),
      ).rejects.toThrow('changed on disk')
      await run('read_file', { path: 'a.txt' })
      await run('write_file', { path: 'a.txt', content: 'updated text' })
      expect(
        JSON.stringify(await run('list_directory', { path: '.' })),
      ).toContain('a.txt')
      expect(
        JSON.stringify(await run('grep', { path: '.', pattern: 'updated' })),
      ).toContain('updated text')
      expect(
        JSON.stringify(await run('find', { path: '.', pattern: '*.txt' })),
      ).toContain('a.txt')
      await expect(
        run('read_file', { path: 'escape/private.txt' }),
      ).rejects.toThrow()
      const bash = JSON.stringify(
        await run('bash', {
          command: `cat ../memory/project_note.md; cat ../memory/.dream/inbox.jsonl; cat escape/private.txt; cat /proc/1/root${artifactDir}/private.txt; true`,
        }),
      )
      expect(bash).toContain('APPROVED_MEMORY')
      expect(bash).not.toContain('PRIVATE_HOST_DATA')
      expect(bash).not.toContain('PRIVATE_INBOX')
      expect(await readFile(join(artifactDir, 'private.txt'), 'utf8')).toBe(
        'PRIVATE_HOST_DATA',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
