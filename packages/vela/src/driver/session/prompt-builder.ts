import {
  addendum,
  type DocsPaths,
  deferredTools,
  docs,
  environment,
  extensionSections,
  preamble,
  projectContext,
  resolveDocs,
  rules,
  SystemPromptBuilder,
  toolList,
  workingDirectory,
} from '../prompt/index.ts'
import { formatSkillsForPrompt } from '../skills/loader.ts'
import type { SessionResources } from './resources.ts'

/** Build stable named sections; their resources are selected by session identity. */
export function createSessionPrompt(
  resource: (id: string) => SessionResources,
  cwdFor: (id: string) => string,
  shellFor: (id: string) => string | undefined,
  docsPaths: DocsPaths | false | undefined,
  isLocalFor: (id: string) => boolean = () => true,
  osFor: (id: string) => string | undefined = () => undefined,
  dateFor: (id: string) => string | undefined = () => undefined,
): SystemPromptBuilder {
  const renderDocs = docs(resolveDocs(docsPaths))
  return new SystemPromptBuilder({
    hasReplacement: (ctx) => resource(ctx.sessionId).systemPrompt !== undefined,
    sections: [
      {
        name: 'preamble',
        render: (ctx) => preamble(resource(ctx.sessionId).systemPrompt)(ctx),
      },
      { name: 'tools', core: true, render: toolList() },
      { name: 'deferred_tools', render: deferredTools() },
      { name: 'rules', core: true, render: rules() },
      {
        name: 'docs',
        core: true,
        render: (ctx) => (isLocalFor(ctx.sessionId) ? renderDocs(ctx) : null),
      },
      {
        name: 'addendum',
        render: (ctx) =>
          addendum(resource(ctx.sessionId).appendSystemPrompt)(ctx),
      },
      {
        name: 'project_context',
        render: (ctx) =>
          projectContext(resource(ctx.sessionId).contextFiles)(ctx),
      },
      {
        name: 'skills',
        render: (ctx) =>
          formatSkillsForPrompt(
            resource(ctx.sessionId).skills,
            (ctx.activeTools ?? []).map((tool) => tool.name),
          ),
      },
      {
        name: 'cwd',
        render: (ctx) => workingDirectory(cwdFor(ctx.sessionId))(ctx),
      },
      {
        name: 'env',
        render: (ctx) =>
          environment({
            os: osFor(ctx.sessionId),
            shell: isLocalFor(ctx.sessionId) ? shellFor(ctx.sessionId) : false,
            date: dateFor(ctx.sessionId),
          })(ctx),
      },
      { name: 'extensions', render: extensionSections() },
    ],
  })
}
