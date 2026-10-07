import type { CommandHandler } from './index'
const DREAM_PROMPT = [
  '请对记忆库做一次完整的整理（dream），按以下四个阶段执行：',
  '',
  '**阶段 1：定位** — 用 memory lint 扫描全库（lint 结果已包含内容预览和问题清单，不需要再逐条 read）。',
  '**阶段 2：整理** — 根据 lint 报告直接操作：',
  '  - 路径过期且长期未用的，直接 memory delete（传 filename）删掉',
  '  - 同名重复的，用 memory save 保存合并后的版本（同名自动覆盖），再 delete 多余的',
  '  - 内容仍然有效但描述不准确的，用 memory save 覆盖更新',
  '**阶段 3：报告** — 用一段文字总结这次整理做了什么。',
  '',
  '注意：memory 的 read 和 delete 都需要传 filename 参数（如 project_deploy-process.md），不是 name。lint 报告里已经有 filename 了，直接用。',
].join('\n')

export const dreamCommands: CommandHandler[] = [
  (cmd, { session, ask }) => {
    if (cmd !== '/dream' && cmd !== 'dream') return false
    if (session.busy.locked) {
      console.log('\n[dream] 有任务正在执行中，请稍候再试\n')
      return true
    }
    console.log('\n[dream] 开始记忆整理...')

    session
      .prompt(DREAM_PROMPT)
      .then(() => console.log(`  [dream 完成]\n`))
      .catch((error: unknown) =>
        console.error(
          `  [dream 失败] ${error instanceof Error ? error.message : error}`,
        ),
      )
      .finally(ask)

    return 'async'
  },
]
