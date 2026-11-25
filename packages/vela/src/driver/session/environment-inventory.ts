import type { ExecutionEnv } from '../execution/types.ts'
import { loadEnvironmentContextFiles } from '../prompt/environment-context-files.ts'
import { loadEnvironmentTemplates } from '../prompt/environment-templates.ts'
import type { ResourceDiagnostic } from '../skills/definition.ts'
import { loadEnvironmentSkills } from '../skills/environment-skills.ts'

/** Shared with the bundled Docker guest. No host paths or configuration cross this boundary. */
export async function readEnvironmentInventory(
  env: ExecutionEnv,
  contextEnabled: boolean,
  signal: AbortSignal,
  declaredSkills: readonly string[] = [],
  declaredPrompts: readonly string[] = [],
) {
  const contextFiles = contextEnabled
    ? await loadEnvironmentContextFiles(env, env.cwd, signal)
    : []
  const home = await env.absolutePath('~/.vela/skills', signal)
  if (!home.ok) throw home.error
  const diagnostics: ResourceDiagnostic[] = []
  const skills = await loadEnvironmentSkills(
    env,
    env.cwd,
    signal,
    false,
    (problem) => diagnostics.push(problem),
    [...declaredSkills, home.value],
  )
  const promptTemplates = await loadEnvironmentTemplates(
    env,
    env.cwd,
    signal,
    declaredPrompts,
  )
  return { contextFiles, skills, promptTemplates, diagnostics }
}
