import {
  backgroundAnsi,
  type Color,
  type Component,
  foregroundAnsi,
  getTerminalColorMode,
  isAppleTerminalSession,
  rgbColor,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'

/**
 * Vela's startup mark: a sailboat, three terminal lines tall. Claude Code draws its crab with
 * foreground and background half blocks in one clay color, and pi draws its mark the same way with
 * brand colors on top of `pi-tui`; this follows pi, so the mark keeps its colors whatever the theme.
 */
const MODE = getTerminalColorMode()
const RESET = '\x1b[0m'

/**
 * The brand colors from `apps/desktop/design/tokens.json` (dark theme), so the terminal mark matches the
 * desktop and Lark surfaces: a coral sail, a deeper terracotta jib, and the teal hull.
 */
const PALETTE: Record<string, Color> = {
  '1': rgbColor(244, 124, 91),
  '2': rgbColor(159, 211, 207),
  '3': rgbColor(194, 70, 43),
}

/**
 * The sailboat, one character per pixel: `.` is transparent, `1` the coral sail, `3` the terracotta
 * jib and `2` the teal hull. Two rows make one terminal line: `▀` for the top pixel, `▄` for the
 * bottom one, `█` when both are painted.
 */
const GRID = [
  '....1....',
  '..311....',
  '.331110..',
  '33311110.',
  '.2222222.',
  '..22222..',
].map((row) => [...row])

/** Columns the mark occupies, and the gap between the mark and the header text. */
export const LOGO_COLUMNS = GRID[0]?.length ?? 0
const LOGO_GAP = 2

/**
 * The text column needs room for the key hints: below this many columns the mark is dropped rather
 * than squeezing the header into an unreadable strip.
 */
const MIN_TEXT_COLUMNS = 32
/** Header padding, one column on each side, which the render width still includes. */
const HEADER_PADDING = 2

/** The mark's lines, ANSI-colored and padded to `LOGO_COLUMNS` so text lines up to their right. */
export function logoLines(): string[] {
  const lines: string[] = []
  for (let row = 0; row < GRID.length; row += 2) {
    const top = GRID[row] ?? []
    const bottom = GRID[row + 1] ?? []
    let line = ''
    for (let column = 0; column < LOGO_COLUMNS; column++)
      line += pixel(top[column], bottom[column])
    lines.push(line)
  }
  return lines
}

/** One terminal cell: the top and bottom pixels of a grid column. */
function pixel(top: string | undefined, bottom: string | undefined): string {
  const up = top ? PALETTE[top] : undefined
  const down = bottom ? PALETTE[bottom] : undefined
  if (up && down)
    return top === bottom
      ? `${foregroundAnsi(up, MODE)}█${RESET}`
      : `${foregroundAnsi(up, MODE)}${backgroundAnsi(down, MODE)}▀${RESET}`
  if (up) return `${foregroundAnsi(up, MODE)}▀${RESET}`
  if (down) return `${foregroundAnsi(down, MODE)}▄${RESET}`
  return ' '
}

/**
 * Whether the terminal can show the mark at `columns`: Apple Terminal misaligns half blocks between
 * lines (see pi's `supportsPiLogo`), and a narrow terminal leaves no room for the text.
 */
export function supportsLogo(
  columns: number,
  appleTerminal = isAppleTerminalSession(),
): boolean {
  return (
    !appleTerminal &&
    columns >= LOGO_COLUMNS + LOGO_GAP + MIN_TEXT_COLUMNS + HEADER_PADDING
  )
}

/** The header text: the mark left of `info`, or the bare lines when the terminal cannot show it. */
export function headerText(info: string[], columns: number): string {
  if (!supportsLogo(columns)) return info.join('\n')
  const textColumns = Math.max(
    1,
    columns - padding(columns) * 2 - LOGO_COLUMNS - LOGO_GAP,
  )
  // Wrap here rather than in `Text`: a wrapped hint has to stay in the text column beside the mark
  const wrapped = info.flatMap((line) => wrapTextWithAnsi(line, textColumns))
  const art = logoLines()
  const gutter = ' '.repeat(LOGO_GAP)
  const rows = Math.max(art.length, wrapped.length)
  const lines: string[] = []
  for (let row = 0; row < rows; row++) {
    const line = art[row] ?? ''
    // A line without a mark keeps the text in its column instead of jumping back to the left edge
    const pad = ' '.repeat(Math.max(0, LOGO_COLUMNS - visibleWidth(line)))
    lines.push(`${line}${pad}${gutter}${wrapped[row] ?? ''}`)
  }
  return lines.join('\n')
}

/**
 * One column of padding on each side, reduced on very narrow terminals. `Text` applies the same
 * rule, so the wrapped text width here matches the width it is finally rendered at.
 */
function padding(columns: number): number {
  return Math.min(1, Math.max(0, Math.floor((columns - 1) / 2)))
}

/**
 * The startup header: the mark beside the session line, key hints and warnings. It renders through
 * `Text` so wrapping, padding and the narrow-terminal fallback stay the same as the text-only header.
 */
export class StartupHeader implements Component {
  private readonly text = new Text('', 1, 0)
  private rendered?: { info: string[]; columns: number }

  constructor(private readonly info: () => string[]) {}

  invalidate(): void {
    this.rendered = undefined
    this.text.invalidate()
  }

  render(columns: number): string[] {
    const info = this.info()
    if (
      this.rendered?.columns !== columns ||
      !sameLines(this.rendered.info, info)
    ) {
      this.text.setText(headerText(info, columns))
      this.rendered = { info, columns }
    }
    return this.text.render(columns)
  }
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index])
}
