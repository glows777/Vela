import type { ModelMessage } from 'ai'
import type { SkillLoader } from '../../skills/loader'
import type { CommandHandler } from './index'

/**
 * 判定 skill 正文是否已作为 user 消息注入过会话。
 * 用 includes 而非 startsWith：/skill load 注入的消息带「已加载 skill」包裹前缀，
 * 触发路径是无包裹拼接，两种形态都能命中。
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

/** skill 的激活状态属于会话：`session.activeSkills`。 */
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
          '\n[skills] 没有找到任何 skill。在 .skills/ 目录下创建 skill-name/SKILL.md 即可。\n',
        )
        return true
      }
      print(`\n[skills] 共 ${skills.length} 个可用：`)
      for (const s of skills) {
        const active = activeSkills.has(s.name) ? ' ✓ 已激活' : ''
        print(`  /${s.name} — ${s.description}${active}`)
        if (s.whenToUse) print(`    适用场景: ${s.whenToUse}`)
      }
      print('')
      return true
    },

    // /skill load <name>
    (cmd, { print, session }) => {
      if (cmd === '/skill load') {
        print('\n[skills] 用法: /skill load <name>\n')
        return true
      }
      const match = cmd.match(/^\/skill\s+load\s+(\S+)$/)
      if (!match) return false
      const name = match[1]
      if (!name) return false
      const skill = skillLoader.get(name)
      if (!skill) {
        print(`\n[skills] 找不到 skill: ${name}\n`)
        return true
      }
      session.activeSkills.add(name)
      // Codex 模式：激活即注入一次正文（system prompt 只保留索引）；
      // 重复 load 不重复注入，避免消息历史线性堆积
      if (contentAlreadyInjected(session.messages, skill.content)) {
        print(`\n[skills] ${name} 内容已在会话中，跳过重复注入\n`)
        return true
      }
      session.append({
        role: 'user',
        content: `[已加载 skill「${name}」，以下是指导内容]\n\n${skill.content}`,
      })
      print(`\n[skills] 已激活: ${name} — ${skill.description}\n`)
      return true
    },

    // /skill unload <name>
    (cmd, { print, session }) => {
      const activeSkills = session.activeSkills
      if (cmd === '/skill unload') {
        print('\n[skills] 用法: /skill unload <name>\n')
        return true
      }
      const match = cmd.match(/^\/skill\s+unload\s+(\S+)$/)
      if (!match) return false
      const name = match[1]
      if (!name) return false
      if (!activeSkills.has(name)) {
        print(`\n[skills] ${name} 未激活\n`)
        return true
      }
      activeSkills.delete(name)
      print(`\n[skills] 已卸载: ${name}\n`)
      return true
    },

    // /<skill-name> — 直接用 /code-review 激活并触发
    (cmd, { print, session }) => {
      if (!cmd.startsWith('/')) return false
      const parts = cmd.slice(1).split(/\s+/)
      const name = parts[0]
      if (!name) return false
      // P0-3 闸：/skill 前缀穿透到此的一律拦截（残缺子命令在各自 handler 已处理）
      if (name === 'skill') {
        print(
          '\n[skills] 未知子命令。可用: /skill list、/skill load <name>、/skill unload <name>\n',
        )
        return true
      }
      const skill = skillLoader.get(name)
      if (!skill) return false

      if (session.busy.locked) {
        print(`\n[skills] 有任务正在执行中，请稍候再尝试 /${name}\n`)
        return true
      }

      session.activeSkills.add(name)
      print(`\n[skills] 激活 ${name}，开始执行...`)

      const args = parts.slice(1).join(' ')
      // P0-2 去重：正文已在会话中出现过则只追加注记，不再注入一遍正文
      const alreadyLoaded = contentAlreadyInjected(
        session.messages,
        skill.content,
      )
      const content = alreadyLoaded
        ? `[skill 已加载] /${name} 的注入内容已在会话中，直接执行。${
            args ? `用户指令: ${args}` : ''
          }`
        : args
          ? `${skill.content}\n\n用户指令: ${args}`
          : skill.content

      return session
        .prompt(content)
        .catch((error: unknown) =>
          print(
            `\n[skills] 执行失败: ${error instanceof Error ? error.message : error}\n`,
          ),
        )
    },
  ]
}
