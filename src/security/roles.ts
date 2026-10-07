/**
 * 会话角色和工具权限。角色属于会话：CLI 主人默认 owner，通道发送者默认 guest。
 *
 * - owner：全部工具
 * - collaborator：除 bash 外全部
 * - guest：不碰本机的工具（知识库检索、网页搜索、延迟工具查询）；不能读写文件、跑命令、用记忆，
 *   system prompt 里也不注入主人的记忆
 */
export type Role = 'owner' | 'collaborator' | 'guest'

export const ROLES: readonly Role[] = ['owner', 'collaborator', 'guest']

/** allow：直接执行；deny：拒绝（模型也看不到这个工具）；ask：执行前用会话的 ui.confirm 询问，没有界面时拒绝 */
export type PermissionDecision = 'allow' | 'deny' | 'ask'

/** 工具名（或 `*` 表示其余工具）→ 决定 */
export type PermissionRules = Record<string, PermissionDecision>

const ROLE_RULES: Record<Role, PermissionRules> = {
  owner: { '*': 'allow' },
  collaborator: { '*': 'allow', bash: 'deny' },
  guest: {
    '*': 'deny',
    rag_search: 'allow',
    web_search: 'allow',
    tool_search: 'allow',
  },
}

/**
 * 某个角色对某个工具的决定。`overrides` 是会话自己的规则（`vela.session(id, { permissions })`）：
 * 精确工具名优先于 `*`，同一层里会话规则优先于角色规则。
 */
export function decidePermission(
  role: Role,
  toolName: string,
  overrides?: PermissionRules,
): PermissionDecision {
  const rules = ROLE_RULES[role]
  return (
    overrides?.[toolName] ??
    rules[toolName] ??
    overrides?.['*'] ??
    rules['*'] ??
    'deny'
  )
}

export function canUseTool(role: Role, toolName: string): boolean {
  return decidePermission(role, toolName) !== 'deny'
}

export function filterToolsForRole(toolNames: string[], role: Role): string[] {
  return toolNames.filter((name) => canUseTool(role, name))
}

/** 能看到主人私有数据（记忆）的角色 */
export const isTrustedRole = (role: Role) =>
  role === 'owner' || role === 'collaborator'
