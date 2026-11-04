import {
  ScrollView,
  TuiAltScreen,
  VStack,
  type Component,
  type Terminal,
} from '@earendil-works/pi-tui'
import { theme } from './theme.ts'

export function createInteractiveTui(
  terminal: Terminal,
  header: Component,
  transcript: Component,
  editorArea: Component,
  footer: Component,
): TuiAltScreen {
  const tui = new TuiAltScreen(terminal, undefined, undefined, {
    scrollToEndIndicator: () =>
      theme.fg('dim', '↓ New output · scroll to bottom'),
  })
  const transcriptView = new ScrollView(transcript, {
    follow: 'end',
    primary: true,
    overscroll: 'chain',
  })
  tui.setLayoutRoot(
    new VStack([
      { component: header, basis: 'auto', shrink: 0, minSize: 1 },
      { component: transcriptView, basis: 0, grow: 1, minSize: 1 },
      { component: editorArea, basis: 'auto', shrink: 1, minSize: 1 },
      { component: footer, basis: 'auto', shrink: 1, minSize: 1 },
    ]),
  )
  return tui
}
