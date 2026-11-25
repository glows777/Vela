import {
  backgroundAnsi,
  type Color,
  type Component,
  foregroundAnsi,
  getTerminalColorMode,
  isAppleTerminalSession,
  rgbColor,
  type TerminalColors,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'

/**
 * Vela's startup mark: a pixel portrait of Vela, three terminal lines tall. Claude Code draws its crab
 * with foreground and background half blocks in one clay color, and pi draws its mark the same way with
 * brand colors on top of `pi-tui`; this follows pi, so the mark keeps its colors whatever the theme.
 */
const MODE = getTerminalColorMode()
const RESET = '\x1b[0m'

/** Which background the portrait is drawn for. */
export type LogoScheme = 'dark' | 'light'

/**
 * The brand colors from `apps/desktop/design/tokens.json`, so the terminal mark matches the desktop
 * and Lark surfaces: `vela-teal` hair, `vela-mint` highlight, a cream face, `vela-accent` cheeks and a
 * near-black for the eyes. Each scheme takes that theme's teal and accent: the dark theme's pale teal
 * has too little contrast on a light background, where the cream face would also blend in without
 * darker hair around it.
 */
const PALETTES: Record<LogoScheme, Record<string, Color>> = {
  dark: {
    t: rgbColor(159, 211, 207),
    m: rgbColor(194, 239, 207),
    f: rgbColor(242, 238, 223),
    a: rgbColor(244, 124, 91),
    k: rgbColor(20, 24, 28),
  },
  light: {
    t: rgbColor(55, 103, 112),
    m: rgbColor(194, 239, 207),
    f: rgbColor(242, 238, 223),
    a: rgbColor(226, 96, 68),
    k: rgbColor(20, 24, 28),
  },
}

/**
 * The scheme for a terminal's default background (its OSC 11 reply): light when the background's
 * relative luminance is above one half. Without a reply the portrait keeps the dark scheme.
 */
export function schemeForBackground(
  background: { r: number; g: number; b: number } | undefined,
): LogoScheme {
  if (!background) return 'dark'
  const channel = (value: number) => {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const luminance =
    0.2126 * channel(background.r) +
    0.7152 * channel(background.g) +
    0.0722 * channel(background.b)
  return luminance > 0.5 ? 'light' : 'dark'
}

/**
 * Vela's face under her teal bob, one character per pixel: `.` is transparent, `t` hair, `m` the mint
 * highlight, `f` face, `k` eyes and `a` cheeks. Two rows make one terminal line: `▀` for the top pixel,
 * `▄` for the bottom one, `█` when both are painted.
 *
 * The app icon is her portrait and the design system rules out a drawn symbol, so the terminal mark is
 * the same character reduced to the few pixels that still read as a face at three lines tall.
 */
const GRID = [
  '..ttmmtt..',
  '.tttttttt.',
  'ttfffffftt',
  'tfkffffkft',
  'tfaffffaft',
  'tt.tttt.tt',
].map((row) => [...row])

/** Columns the mark occupies, the lines it takes, and the gap before the header text. */
export const LOGO_COLUMNS = GRID[0]?.length ?? 0
export const LOGO_LINES = GRID.length / 2
const LOGO_GAP = 2

/**
 * The text column needs room for the key hints: below this many columns the mark is dropped rather
 * than squeezing the header into an unreadable strip.
 */
const MIN_TEXT_COLUMNS = 32
/** Header padding, one column on each side, which the render width still includes. */
const HEADER_PADDING = 2

/** The mark's lines, ANSI-colored and padded to `LOGO_COLUMNS` so text lines up to their right. */
export function logoLines(scheme: LogoScheme = 'dark'): string[] {
  const palette = PALETTES[scheme]
  const lines: string[] = []
  for (let row = 0; row < GRID.length; row += 2) {
    const top = GRID[row] ?? []
    const bottom = GRID[row + 1] ?? []
    let line = ''
    for (let column = 0; column < LOGO_COLUMNS; column++)
      line += pixel(palette, top[column], bottom[column])
    lines.push(line)
  }
  return lines
}

/** One terminal cell: the top and bottom pixels of a grid column. */
function pixel(
  palette: Record<string, Color>,
  top: string | undefined,
  bottom: string | undefined,
): string {
  const up = top ? palette[top] : undefined
  const down = bottom ? palette[bottom] : undefined
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
export function headerText(
  info: string[],
  columns: number,
  scheme: LogoScheme = 'dark',
): string {
  if (!supportsLogo(columns)) return info.join('\n')
  const textColumns = Math.max(
    1,
    columns - padding(columns) * 2 - LOGO_COLUMNS - LOGO_GAP,
  )
  // Wrap here rather than in `Text`: a wrapped hint has to stay in the text column beside the mark
  const wrapped = info.flatMap((line) => wrapTextWithAnsi(line, textColumns))
  const art = logoLines(scheme)
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

/** What the header needs from the TUI to learn the terminal's background and redraw. */
export interface BackgroundSource {
  queryTerminalColors(options: {
    timeoutMs: number
    onLateReply?: (colors: TerminalColors) => void
  }): Promise<TerminalColors>
  requestRender(): void
}

/** Each TUI's detected scheme; a TUI is asked once however often the header is rebuilt. */
const schemes = new WeakMap<BackgroundSource, LogoScheme>()

/**
 * Ask the terminal for its background (OSC 11) and redraw when it is light. Until the reply, and for a
 * terminal that never answers, the portrait stays in the dark palette, so startup never waits on it.
 */
function detectScheme(tui: BackgroundSource): void {
  if (schemes.has(tui)) return
  schemes.set(tui, 'dark')
  const apply = (colors: TerminalColors) => {
    const scheme = schemeForBackground(colors.background)
    if (scheme === schemes.get(tui)) return
    schemes.set(tui, scheme)
    tui.requestRender()
  }
  void tui
    .queryTerminalColors({ timeoutMs: 500, onLateReply: apply })
    .then(apply)
}

/**
 * The startup header: the mark beside the session line, key hints and warnings. It renders through
 * `Text` so wrapping, padding and the narrow-terminal fallback stay the same as the text-only header.
 * Given the TUI, it asks the terminal for its background once and picks the portrait's palette from it.
 */
export class StartupHeader implements Component {
  private readonly text = new Text('', 1, 0)
  private rendered?: { info: string[]; columns: number; scheme: LogoScheme }

  constructor(
    private readonly info: () => string[],
    private readonly tui?: BackgroundSource,
  ) {
    if (tui) detectScheme(tui)
  }

  invalidate(): void {
    this.rendered = undefined
    this.text.invalidate()
  }

  render(columns: number): string[] {
    const info = this.info()
    const scheme = (this.tui && schemes.get(this.tui)) ?? 'dark'
    if (
      this.rendered?.columns !== columns ||
      this.rendered.scheme !== scheme ||
      !sameLines(this.rendered.info, info)
    ) {
      this.text.setText(headerText(info, columns, scheme))
      this.rendered = { info, columns, scheme }
    }
    return this.text.render(columns)
  }
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index])
}
