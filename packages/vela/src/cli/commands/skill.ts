import type { CommandHandler } from './index.ts'

/**
 * `/skill` lists skills. The model loads a skill itself by reading its file; `/skill:<name> args` sends one
 * explicitly and is expanded by session.prompt() (like pi), so it is not a CLI command.
 */
export function createSkillCommands(): CommandHandler[] {
  return [
    (cmd, { print, session }) => {
      if (cmd !== '/skill' && cmd !== '/skills' && cmd !== '/skill list')
        return false
      return (async () => {
        const skills = (await session.resources()).skills
        if (skills.length === 0) {
          print(
            '\n[skills] No skills found. Create .vela/skills/<name>/SKILL.md (with name and description frontmatter) to add one.\n',
          )
          return
        }
        print(
          `\n[skills] ${skills.length} available (run one with /skill:<name>):`,
        )
        for (const s of skills) {
          const manual = s.disableModelInvocation ? ' (manual only)' : ''
          print(`  /skill:${s.name} — ${s.description}${manual}`)
        }
        print('')
      })()
    },
  ]
}
