import type { ModelMessage } from 'ai'
import type { SkillLoader } from '../../skills/loader.ts'
import type { CommandHandler } from './index.ts'

/**
 * Whether the skill body was already injected into the session as a user message.
 * Uses includes, not startsWith: /skill load wraps the body in a "Loaded skill" prefix while
 * the trigger path concatenates it unwrapped, and both forms must match.
 */
function contentAlreadyInjected(
  messages: ModelMessage[],
  content: string,
): boolean {
  if (!content) return false
  return messages.some((m) => {
    if (m.role !== 'user' || typeof m.content !== 'string') return false
    return m.content.includes(content)
  })
}

/** Skill activation state belongs to the session: `session.activeSkills`. */
export function createSkillCommands(
  skillLoader: SkillLoader,
): CommandHandler[] {
  return [
    // /skill list
    (cmd, { print, session }) => {
      if (cmd !== '/skill' && cmd !== '/skill list' && cmd !== 'skill list')
        return false
      const activeSkills = session.activeSkills
      const skills = skillLoader.list()
      if (skills.length === 0) {
        print(
          '\n[skills] No skills found. Create .skills/skill-name/SKILL.md to add one.\n',
        )
        return true
      }
      print(`\n[skills] ${skills.length} available:`)
      for (const s of skills) {
        const active = activeSkills.has(s.name) ? ' ✓ active' : ''
        print(`  /${s.name} — ${s.description}${active}`)
        if (s.whenToUse) print(`    When to use: ${s.whenToUse}`)
      }
      print('')
      return true
    },

    // /skill load <name>
    (cmd, { print, session }) => {
      if (cmd === '/skill load') {
        print('\n[skills] Usage: /skill load <name>\n')
        return true
      }
      const match = cmd.match(/^\/skill\s+load\s+(\S+)$/)
      if (!match) return false
      const name = match[1]
      if (!name) return false
      const skill = skillLoader.get(name)
      if (!skill) {
        print(`\n[skills] Skill not found: ${name}\n`)
        return true
      }
      // A message appended mid-run would land before this turn's answer and break history order
      if (session.busy.locked) {
        print(`\n[skills] A task is running; try /skill load ${name} again when it finishes\n`)
        return true
      }
      session.activeSkills.add(name)
      // Codex style: activating injects the body once (the system prompt keeps only the index);
      // loading again does not re-inject, so history doesn't grow linearly
      if (contentAlreadyInjected(session.messages, skill.content)) {
        print(`\n[skills] ${name} is already in the session; not injecting again\n`)
        return true
      }
      session.append({
        role: 'user',
        content: `[Loaded skill "${name}". Instructions follow]\n\n${skill.content}`,
      })
      print(`\n[skills] Activated: ${name} — ${skill.description}\n`)
      return true
    },

    // /skill unload <name>
    (cmd, { print, session }) => {
      const activeSkills = session.activeSkills
      if (cmd === '/skill unload') {
        print('\n[skills] Usage: /skill unload <name>\n')
        return true
      }
      const match = cmd.match(/^\/skill\s+unload\s+(\S+)$/)
      if (!match) return false
      const name = match[1]
      if (!name) return false
      if (!activeSkills.has(name)) {
        print(`\n[skills] ${name} is not active\n`)
        return true
      }
      activeSkills.delete(name)
      print(`\n[skills] Unloaded: ${name}\n`)
      return true
    },

    // /<skill-name>: e.g. /code-review activates and runs the skill directly
    (cmd, { print, session }) => {
      if (!cmd.startsWith('/')) return false
      const parts = cmd.slice(1).split(/\s+/)
      const name = parts[0]
      if (!name) return false
      // P0-3 gate: anything with the /skill prefix that falls through to here is blocked (incomplete subcommands are handled by their own handlers)
      if (name === 'skill') {
        print(
          '\n[skills] Unknown subcommand. Available: /skill list, /skill load <name>, /skill unload <name>\n',
        )
        return true
      }
      const skill = skillLoader.get(name)
      if (!skill) return false

      if (session.busy.locked) {
        print(`\n[skills] A task is running; try /${name} again when it finishes\n`)
        return true
      }

      session.activeSkills.add(name)
      print(`\n[skills] Activating ${name} and running...`)

      const args = parts.slice(1).join(' ')
      // P0-2 dedup: if the body is already in the session, append only a note instead of the body again
      const alreadyLoaded = contentAlreadyInjected(
        session.messages,
        skill.content,
      )
      const content = alreadyLoaded
        ? `[skill loaded] The content for /${name} is already in the session; run it now.${
            args ? ` User instruction: ${args}` : ''
          }`
        : args
          ? `${skill.content}\n\nUser instruction: ${args}`
          : skill.content

      return session
        .prompt(content)
        .catch((error: unknown) =>
          print(
            `\n[skills] Run failed: ${error instanceof Error ? error.message : error}\n`,
          ),
        )
    },
  ]
}
