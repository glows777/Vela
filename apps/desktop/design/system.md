Vela is an AI coworker for your group chat, and the website presents it as **a run of printed manga plates**: white paper, evergreen ink and mint, with one vermilion signal. Every illustration is printed by one halftone press, the group chat is drawn as manga scenes, and the page reads in plain sentences that say exactly what exists.

This is Vela's one design system, for the website, the app and anything else that carries the brand (decks, posts, docs pages). It has two layers. **The foundations are shared**: content, colour, themes, type, wordmark, portrait and iconography below, and one set of tokens. **Each surface adds its own rules**: the website's are the sections marked *Website* below, built from vela-website; the app's are in the **App** section, with its components in the groups named *App*.

## Content fundamentals

- **Say what Vela is first, in the README's words**: "An AI coworker for your group chat." The product is *Vela*; the author says *I* only in the closing origin note. Never "we".
- **Short declaratives that end in a full stop**, headings included: "It works in your group chat.", "Bigger job? It opens a topic.", "Three ways in.", "What it is made of." Buttons and links have no full stop: "See it in a group", "Get started ↗", "Watch the film".
- **Sentence case** for headings and copy. **Uppercase with wide tracking** (`label`) only for small labels: `PLATE 02 / IN THE GROUP`, `01 / 03`, `SCROLL`.
- **Honest scope.** Say what is built and what is still being drawn ("Early: no sandbox."). The group-chat scenes say they are drawn ("Drawn scenes of how the Lark channel works today."). The recorded run says it is a recording and that its text is translated.
- **Name the platform Lark**, never Feishu or 飞书, in every language (zh: "Lark 群").
- **No emoji.** Decorative Japanese (第一話, 起, 話, 試作, つづく, ヴェラ) stays Japanese on every locale and is `aria-hidden`. Page copy is translated (English is the source; 中文 and 日本語 fall back to it key by key).

## Colour

- The ground is `white`; paper surfaces (the chat window, narration boxes, finale pieces) are `paper`. Text is `ink`, secondary text `muted`.
- **The page ground changes with the section.** While the ways-in section or the finale holds the middle of the screen, the whole page fades to `inverse` with `on-inverse` text, `on-evergreen-muted` secondary copy and `terminal-border` rules, on `ease-in-out` over .7s. Components read the ground through `--ground`, `--fg`, `--fg-soft` and `--rule-c`, never through a theme check.
- `mint` is the signature tint: the hero's halftone disc, the round icon inside every pill, Vela's chat bubbles, done progress steps, the settei hover sweep, and the way-in commands (as text, only on `inverse`). Never set small `mint` text on white.
- `accent` (vermilion) is the single signal, for graphics and focus: focus rings, the terminal's red light, the settei kanji, the finale label. **Vermilion text uses `accent-ink`**: 第一話 in the kicker, the kanji in a plate label, a pending part's status pill. The seal takes `note-accent`.
- `teal` is only the giant hero VELA and its outline; `wordmark-offset` is its offset copy.
- **Fills that stay dark** use `inverse` with `on-inverse`: the run terminal and the ink ground. Text on a fill uses its pair: `on-button`, `on-mint`, `on-accent`. Never put `white` or `ink` on a fill: they swap in Dark.
- **The film is the one other look.** It plays in a screening room over the page on its own dark ground (`film-ground`, `film-text`, `film-dim`, `film-line`) in every theme, and never sits inside a section.
- **Contrast.** Text pairs meet 4.5:1 in all three themes (High contrast 7:1). `accent` is 3:1 graphics only. Every control's edge is `border-strong` (at least 3:1 in every theme); `line` is only for decorative hairlines. One known gap, kept exact here: the `note-accent` seal is about 2.4:1 on the Dark ground; it is decoration.

## Themes

Three themes share one set of names, so components never branch on theme.

- **Light** is the site as it ships.
- **Dark is the Light page at night**: paper and ink swap (the page becomes evergreen `#0f2c2a`, words a warm cream `#f2eedf`), the primary pill becomes warm paper with evergreen text, `mint` keeps its strength with evergreen text on it, and `accent` keeps its one job.
- **High contrast** is an added theme: every text pair at least 7:1, borders at least 3:1, `accent` darkened to text strength.
- **Choosing a theme.** With no stored choice the page follows the system (more contrast selects High contrast, even over a dark scheme). The **Theme switch** stores a choice under `vela:theme`, applied before first paint as `data-theme` on `<html>`. The browser `theme-color` follows the theme's `white`.

## Type

- **Display**: Barlow Condensed 800 (`display`) for every headline: `section-title`, `beat-title`, `part-name`, `desk-title`, `shot-line`, the giant `hero-type` VELA and the `mark`. Tight leading (.84-.88) and -0.02em tracking.
- **Text**: Arial (`sans`). The one exception among headlines is `hero-title`, bold Arial at -0.04em. Reading copy is `lede` (15-18px, line-height 1.55) in `--fg-soft`; chats use `chat`.
- **Mono** (`mono`) for the way-in `command`s, the run `terminal` and `code` samples.
- **Chinese and Japanese**: Arial stays first so Latin matches, then a native face (`sans-zh`, `sans-ja`), set on the root by `lang`. Display headlines in zh and ja take line-height 1.14 and no tracking, and beat titles step down to clamp(40px, 4.4vw, 84px); ja adds `word-break: auto-phrase`. Always check zh and ja, not only en.
- **Japanese decoration**: Shippori Mincho B1 800 (`mincho`) for seals, plate-label kanji, the vertical ヴェラ and つづく. The font file is a glyph subset: set only characters the site already uses (`ja-glyphs.txt` in the source repository) or let the stack fall back.
- Sizes are fluid on the site. Each type style records its desktop maximum and its usage note gives the site's clamp().

## Wordmark and portrait

Vela has two marks: the word **VELA** and the character portrait. There is no abstract symbol: no sail, monogram or emblem stands in for either. (The app's wordmark sizes are in **App**.)

- **Wordmark.** The word **VELA** in Barlow Condensed: in the masthead and footer as `mark` (24px, 0.08em, `ink`), and behind the hero as the giant `hero-type` VELA, `teal` letters spread edge to edge over a `wordmark-offset` copy shifted 0.9vw down and right, with a `teal` outline trace in front of the portrait.
- **Portrait.** The character is the icon: the app icons in **Icons** are her portrait.
- **Terminal portrait.** Where only text cells are available (the CLI's startup header), the portrait is reduced to a 10-column, three-line pixel face drawn with half blocks: `teal` (dark) hair with one `mint` highlight, an `ink` (dark) face, near-black eyes and `accent` (dark) cheeks. It sits left of the header text and keeps these colors in every theme. Its grid lives in `packages/vela/src/cli/tui/logo.ts`; change it there, not by drawing a new mark. Terminals that cannot draw it (Apple Terminal, or narrower than 46 columns) show text only.

## Website: layout and shape

- The page gutter is `gutter` (clamp(18px, 3.2vw, 56px)). Sections are full width with generous vertical padding (about 100-200px).
- **Two shapes, kept apart.** *Manga panels are square* (`radius-none`) with thick `ink` frames (2.5px): the shot frame, narration boxes, beat panels and their numbers. *Things you touch or read as UI are round*: pills (`radius-pill`) for every button, chip and menu trigger; `radius-window` for the chat window and terminal; `radius-card` for the progress card and menus; `radius-chip` for code blocks and popovers; `radius-round` for faces, rings and round icons.
- **Panels are cut by paper, not by shadows.** A beat headline sits over its panel's bottom edge and is cut out of it by a `white` outline (four stacked drop-shadows of 0.05em). The chat window gets a screentone shade (`ink` dots on a 7px grid) offset 14px, not a blur. Soft shadows are rare: `paper-shadow` for open menus and the popover, `terminal-shadow` for the terminal.
- **Never overlay decoration on text the reader must read.** Nothing is printed over chat text; captions only overlap the art they belong to.
- **Breakpoints**: one reading column at 820px and below (`bp-phone`); beats then stack with the headline first.

## Website: halftone and imagery

- Every illustration is a **plate**: an element holding a plain `<img>` that one fixed WebGL canvas reprints as halftone dots (6-7px cells). Dots grow in when a plate prints, one picture's dots turn into the next when the shot changes scene, and pointer and scroll speed push the dot field. Without WebGL the `<img>` stays visible. DOM blocks (the chat window, the terminal) print in with a CSS dot mask on a 12px grid.
- Artwork is original Japanese-anime art of Vela (teal hair, calm, slightly playful), cel-shaded. Use the images in **Artwork** only where the story puts them; crop uniformly, never stretch a face.
- Printer's marks frame the hero: registration crosses, crop corners, a plate label (`起 PLATE 01 / AGENT`) and a scroll cue.

## Website: motion

Motion is an enhancement: without the motion layer, or under `prefers-reduced-motion`, every section shows its finished layout.

- **One language.** Anything that arrives decelerates (`expo.out`, `ease-out` in CSS); anything that changes in place eases both ways (`power2.inOut`, `ease-in-out`); anything that follows the hand (pointer, scroll speed, dragged finale pieces) moves on springs or physics.
- **Scrolling is never held.** Lenis smooths the scroll; only the once-per-tab intro (a press count while the art loads) pauses it. The hero-to-desk shot is a CSS sticky stage that plays on its own clock once it is on screen; scrolling on pulls it forward and scrolling back rewinds it.
- Headlines rise line by line out of masks; text rolls on hover (`data-roll`: the label slides up and a copy slides in); seals stamp in; the settei part sweeps `mint` in from the bottom on hover.
- The film opens in the top layer with the intro's curtain reversed (`ease-shutter`).

## Website: states

- **Focus:** a 3px solid `accent` outline at a 4px offset (inset on the terminal output).
- **Hover:** labels roll; pill icons nudge; a settei part fills `mint` with `on-mint` text and its kanji stamps in; menu items take `menu-hover`; a quiet link's `mint` underline becomes `accent`.

## Iconography

**Website:** there is no icon library. The few icons are inline SVGs stroked in `currentColor` (1.4-1.8px): the pill arrows (down `M10 4v12M5 11l5 5 5-5` for an in-page link, diagonal `M6 14L14 6M7 6h7v7` for an external one), the film's play triangle (filled), the language chevron, the theme glyph (a split ring with three hatches), the clock in a routine chip and the sound-toggle bell. Icons inside pills sit in a `mint` disc with `on-mint` strokes. Terminal glyphs are typographic (`›`, `·`), and the recording note's glyph is an italic Georgia "i" in a ring.

**App:** every icon is from Lucide; see **Icons in the app** in the App section.

## Not synced

- The App section and the `.app` block at the end of `components/bundle.css` are the app's own and are not synced from the site. On a site sync, replace only the part of bundle.css above the `===== App =====` marker.

- `favicon.ico`: `.ico` is not a type this system can store; the PNG icons in **Icons** are the same portrait.
- The halftone press, the shot, Lenis, the sound layer and the finale's physics are scripts; the components here are **static renditions** whose styles are the site's own stylesheet (`components/bundle.css`), without the motion layer.
- Synced from vela-website `claude/project-thread-dnwet5@fba8844` (PR #30, the 3:1 control edge, on top of `main@042bff3`) on 2026-11-05.
