export type RiskLevel = 'safe' | 'moderate' | 'dangerous'

interface ClassifyResult {
  level: RiskLevel
  reason?: string
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*-rf\b|.*--force)/,
    reason: '强制删除文件',
  },
  { pattern: /\brm\s+-[a-zA-Z]*r/, reason: '递归删除' },
  { pattern: /\bsudo\b/, reason: '提权操作' },
  { pattern: /\bmkfs\b/, reason: '格式化磁盘' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: '直接写设备' },
  { pattern: /:\(\)\s*\{.*\|.*&\s*\}/, reason: 'Fork bomb' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: '覆写磁盘设备' },
  { pattern: /\bchmod\s+777\b/, reason: '开放所有权限' },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh/, reason: '远程脚本执行' },
  { pattern: /\bwget\b.*\|\s*(ba)?sh/, reason: '远程脚本执行' },
  { pattern: /\beval\b/, reason: 'eval 动态执行' },
  { pattern: />\s*\/etc\//, reason: '覆写系统配置' },
]

const MODERATE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\b/, reason: '删除文件' },
  { pattern: /\bmv\b/, reason: '移动/重命名文件' },
  { pattern: /\bchmod\b/, reason: '修改权限' },
  { pattern: /\bchown\b/, reason: '修改所有者' },
  { pattern: /\bkill\b/, reason: '终止进程' },
  { pattern: /\bpkill\b/, reason: '批量终止进程' },
  { pattern: /\bgit\s+push\b/, reason: 'Git 推送' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'Git 硬重置' },
  { pattern: /\bnpm\s+publish\b/, reason: '发布 npm 包' },
  { pattern: /\bdocker\s+rm\b/, reason: '删除容器' },
]

export function classifyBashCommand(command: string): ClassifyResult {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'dangerous', reason }
    }
  }

  for (const { pattern, reason } of MODERATE_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'moderate', reason }
    }
  }

  return { level: 'safe' }
}
