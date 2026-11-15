import { expect, test } from 'bun:test'
import {
  addendum,
  deferredTools,
  docs,
  extensionSections,
  type PromptContext,
  type PromptSection,
  preamble,
  projectContext,
  resolveDocs,
  rules,
  SystemPromptBuilder,
  toolList,
  workingDirectory,
} from '../../../src/prompt/index.ts'

const context: PromptContext = {
  deferredToolSummary: '',
  sessionId: 'test',
}

/** The prompt as Vela assembles it, without context files, skills or extensions */
function builder(
  options: { systemPrompt?: string; sections?: PromptSection[] } = {},
): SystemPromptBuilder {
  return new SystemPromptBuilder({
    systemPrompt: options.systemPrompt,
    sections: options.sections ?? [
      { name: 'preamble', render: preamble() },
      { name: 'tools', core: true, render: toolList() },
      { name: 'deferred_tools', render: deferredTools() },
      { name: 'rules', core: true, render: rules() },
      { name: 'addendum', render: addendum('Answer in French.') },
      { name: 'cwd', render: workingDirectory('/work') },
    ],
  })
}

const tools: PromptContext['activeTools'] = [
  {
    name: 'read_file',
    promptSnippet: 'Read file contents',
    promptGuidelines: ['Use read_file instead of cat.'],
  },
  { name: 'bash', promptSnippet: 'Run a shell command' },
  { name: 'tool_search', promptSnippet: 'Load tools on demand' },
]
const withTools: PromptContext = { ...context, activeTools: tools }

test('sections render in order, tagged with their name and the preamble plain', () => {
  expect(
    builder()
      .sections(context)
      .map(({ name }) => name),
  ).toEqual(['preamble', 'tools', 'rules', 'addendum', 'cwd'])
  const prompt = builder().build(context)
  expect(prompt.startsWith('You are Vela')).toBe(true)
  expect(prompt).toContain('<tools>\n(none)\n</tools>')
  expect(prompt).toContain('<addendum>\nAnswer in French.\n</addendum>')
  expect(prompt).toContain('<cwd>\n/work\n</cwd>')
  // Sections are joined with a blank line, like pi
  expect(prompt.split('</rules>\n\n<addendum>')).toHaveLength(2)
})

test('a section that renders nothing is left out, and status reports it off', () => {
  const prompt = builder().build(context)
  expect(prompt).not.toContain('<deferred_tools>')
  expect(builder().status(context)).toEqual([
    { name: 'preamble', chars: expect.any(Number) },
    { name: 'tools', chars: expect.any(Number) },
    { name: 'deferred_tools', chars: null },
    { name: 'rules', chars: expect.any(Number) },
    { name: 'addendum', chars: 17 },
    { name: 'cwd', chars: 5 },
  ])
})

test('<tools> lists the active tools that have a snippet, and rules only carry their guidelines', () => {
  const prompt = builder().build(withTools)
  expect(prompt).toContain(
    '<tools>\n- read_file: Read file contents\n- bash: Run a shell command\n- tool_search: Load tools on demand\n</tools>',
  )
  expect(prompt).toContain('- Use read_file instead of cat.')
  expect(prompt).not.toContain('edit_file')
  expect(prompt).not.toContain('write_file')
})

test('a tool that is off contributes neither a line nor a rule', () => {
  const prompt = builder().build({
    ...context,
    activeTools: [
      { name: 'bash', promptSnippet: 'Run a shell command' },
      {
        name: 'edit_file',
        promptGuidelines: ['Read a file before you change it.'],
      },
    ],
  })
  // A guideline without a snippet still adds its rule, but the tool is not listed
  expect(prompt).toContain('<tools>\n- bash: Run a shell command\n</tools>')
  expect(prompt).toContain('Read a file before you change it.')
})

test('<deferred_tools> needs deferred tools and an active tool_search', () => {
  const deferred: PromptContext = {
    ...withTools,
    deferredToolSummary: '- mcp__docs (2 tools) — Docs',
  }
  expect(builder().build(deferred)).toContain(
    '<deferred_tools>\nThese tools are available but not loaded. Call tool_search with keywords or tool names to load the ones you need:\n- mcp__docs (2 tools) — Docs\n</deferred_tools>',
  )
  // Nothing to load: no section
  expect(
    builder().build({ ...withTools, deferredToolSummary: '' }),
  ).not.toContain('<deferred_tools>')
  // No tool_search: the model could not load them, so the list stays out
  expect(
    builder().build({
      ...context,
      activeTools: [{ name: 'bash', promptSnippet: 'Run a shell command' }],
      deferredToolSummary: '- mcp__docs (2 tools) — Docs',
    }),
  ).not.toContain('<deferred_tools>')
})

test('rules deduplicate what tools and the standing list both say', () => {
  const prompt = builder().build({
    ...context,
    activeTools: [
      {
        name: 'a',
        promptGuidelines: ['Show file paths clearly when working with files.'],
      },
      {
        name: 'b',
        promptGuidelines: ['Show file paths clearly when working with files.'],
      },
    ],
  })
  expect(
    prompt.split('Show file paths clearly when working with files.').length,
  ).toBe(2)
})

test('a system prompt replaces the preamble and drops tools, rules and docs', () => {
  const sections: PromptSection[] = [
    { name: 'preamble', render: preamble('You are Exact.') },
    { name: 'tools', core: true, render: toolList() },
    { name: 'rules', core: true, render: rules() },
    {
      name: 'docs',
      core: true,
      render: docs({ docs: '/vela/docs', readme: '/vela/README.md' }),
    },
    { name: 'addendum', render: addendum('Answer in French.') },
    { name: 'cwd', render: workingDirectory('/work') },
  ]
  const replaced = new SystemPromptBuilder({
    systemPrompt: 'You are Exact.',
    sections,
  }).build(withTools)
  expect(replaced.startsWith('You are Exact.\n\n<addendum>')).toBe(true)
  for (const tag of ['<tools>', '<rules>', '<docs>'])
    expect(replaced).not.toContain(tag)
  // A handler's prompt is the whole prompt for this turn
  const overridden = new SystemPromptBuilder({ sections }).build({
    ...withTools,
    systemPromptOverride: 'You are Exact for this turn.',
    extensionSections: { memory: 'Rules' },
  })
  expect(overridden).toBe('You are Exact for this turn.')
  expect(
    new SystemPromptBuilder({ sections }).status({
      ...withTools,
      systemPromptOverride: 'ABCD',
    })[0],
  ).toEqual({ name: 'systemPrompt', chars: 4 })
})

test('an extension section that uses a built-in name adds to it instead of replacing it', () => {
  const sections: PromptSection[] = [
    { name: 'preamble', render: preamble() },
    { name: 'tools', core: true, render: toolList() },
    { name: 'rules', core: true, render: rules() },
    { name: 'extensions', render: extensionSections() },
  ]
  const prompt = new SystemPromptBuilder({ sections }).build({
    ...context,
    activeTools: [{ name: 'edit_file', promptGuidelines: ['Read first.'] }],
    extensionSections: { rules: 'Use the project conventions.' },
  })
  // Both contributions are in the prompt: the built-in rules, then the extension's own section
  expect(prompt).toContain('- Use tools to check facts')
  expect(prompt).toContain('- Read first.')
  expect(prompt).toContain('<rules>\nUse the project conventions.\n</rules>')
  expect(prompt.match(/<rules>/g)).toHaveLength(2)
  expect(
    new SystemPromptBuilder({ sections })
      .sections({
        ...context,
        extensionSections: { rules: 'Use the project conventions.' },
      })
      .map(({ name }) => name),
  ).toEqual(['preamble', 'tools', 'rules', 'rules'])
})

test('extension sections are rendered under their own tags, in write order', () => {
  const withExtensions = new SystemPromptBuilder({
    sections: [
      { name: 'preamble', render: preamble() },
      { name: 'extensions', render: extensionSections() },
    ],
  })
  const prompt = withExtensions.build({
    ...context,
    extensionSections: { memory: 'How to use memory', channelTopic: 'Topic' },
  })
  expect(prompt).toContain('<memory>\nHow to use memory\n</memory>')
  expect(prompt).toContain('<channelTopic>\nTopic\n</channelTopic>')
  expect(prompt.indexOf('<memory>')).toBeLessThan(
    prompt.indexOf('<channelTopic>'),
  )
  // A name that cannot be a tag is made safe instead of breaking the prompt
  expect(
    withExtensions.build({
      ...context,
      extensionSections: { '1 weird/name': 'x' },
    }),
  ).toContain('<section_1_weird_name>\nx\n</section_1_weird_name>')
})

test('<docs> points at the folders that exist and stays off without a docs folder', () => {
  const render = (paths: Parameters<typeof docs>[0]) =>
    new SystemPromptBuilder({
      sections: [{ name: 'docs', render: docs(paths) }],
    }).build(context)
  expect(render(undefined)).toBe('')
  expect(resolveDocs(false)).toBeUndefined()
  expect(resolveDocs({ docs: '/nope/docs' })).toBeUndefined()

  const paths = resolveDocs({
    docs: import.meta.dir,
    readme: `${import.meta.dir}/system-prompt.test.ts`,
    examples: '/nope/examples',
  })
  expect(paths).toEqual({
    docs: import.meta.dir,
    readme: `${import.meta.dir}/system-prompt.test.ts`,
  })
  const section = render(paths)
  expect(section).toContain('- Additional docs: ')
  expect(section).toContain('system-prompt.test.ts')
  expect(section).not.toContain('Examples:')
  expect(section).toContain('Before changing Vela itself')
})

test('project context is its own section, without a nested wrapper', () => {
  const render = (files: Parameters<typeof projectContext>[0]) =>
    new SystemPromptBuilder({
      sections: [{ name: 'project_context', render: projectContext(files) }],
    }).build(context)
  expect(render([])).toBe('')
  expect(render([{ path: '/repo/AGENTS.md', content: 'Use bun.' }])).toBe(
    '<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/repo/AGENTS.md">\nUse bun.\n</project_instructions>\n</project_context>',
  )
})
