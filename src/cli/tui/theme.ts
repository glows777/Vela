import {
  type Color,
  type EditorTheme,
  getTerminalColorMode,
  type MarkdownTheme,
  okhslColor,
  type SelectListTheme,
  styleText,
  type TextStyle,
} from '@earendil-works/pi-tui'
import type { ThinkingLevel } from '../../models/index.ts'

/** Colors from pi's default dark theme (okhsl), only the ones Vela uses. */
const c = (h: number, s: number, l: number) => okhslColor(h, s / 100, l / 100)
const COLORS = {
  text: c(234, 3, 89),
  muted: c(229, 6, 67),
  dim: c(229, 8, 56),
  accent: c(295, 50, 67),
  blue: c(232, 54, 67),
  green: c(159, 59, 67),
  red: c(20, 72, 67),
  yellow: c(83, 88, 67),
  border: c(231, 57, 65),
  borderMuted: c(229, 8, 53),
  thinkingText: c(226, 7, 65),
  userBg: c(233, 41, 24),
  toolPendingBg: c(229, 5, 24),
  toolSuccessBg: c(158, 46, 25),
  toolErrorBg: c(19, 54, 25),
  selectedBg: c(233, 41, 24),
  customMessageBg: c(295, 42, 24),
} satisfies Record<string, Color>

/** Editor border color follows the thinking level (like pi) */
const THINKING_COLORS: Record<ThinkingLevel, Color> = {
  off: c(229, 8, 49),
  minimal: c(232, 20, 52),
  low: c(232, 45, 54),
  medium: c(263, 59, 56),
  high: c(295, 73, 59),
  xhigh: c(337, 81, 61),
  max: c(20, 99, 63),
}

type ColorName = keyof typeof COLORS

const mode = getTerminalColorMode()
const style = (text: string, options: TextStyle) =>
  styleText(text, options, mode)

export const theme = {
  fg: (color: ColorName, text: string) => style(text, { fg: COLORS[color] }),
  bg: (color: ColorName, text: string) => style(text, { bg: COLORS[color] }),
  bold: (text: string) => style(text, { bold: true }),
  italic: (text: string) => style(text, { italic: true }),
  thinkingBorder: (level: ThinkingLevel) => (text: string) =>
    style(text, { fg: THINKING_COLORS[level] }),
}

export const markdownTheme: MarkdownTheme = {
  heading: (t) => style(t, { fg: COLORS.yellow, bold: true }),
  link: (t) => theme.fg('blue', t),
  linkUrl: (t) => theme.fg('muted', t),
  code: (t) => theme.fg('accent', t),
  codeBlock: (t) => theme.fg('green', t),
  codeBlockBorder: (t) => theme.fg('muted', t),
  quote: (t) => theme.fg('muted', t),
  quoteBorder: (t) => theme.fg('muted', t),
  hr: (t) => theme.fg('muted', t),
  listBullet: (t) => theme.fg('accent', t),
  bold: (t) => style(t, { bold: true }),
  italic: (t) => style(t, { italic: true }),
  strikethrough: (t) => style(t, { strikethrough: true }),
  underline: (t) => style(t, { underline: true }),
}

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (t) => theme.fg('accent', t),
  selectedText: (t) => style(t, { fg: COLORS.accent, bold: true }),
  description: (t) => theme.fg('muted', t),
  scrollInfo: (t) => theme.fg('dim', t),
  noMatch: (t) => theme.fg('dim', t),
}

export const editorTheme: EditorTheme = {
  borderColor: (t) => theme.fg('border', t),
  selectList: selectListTheme,
}
