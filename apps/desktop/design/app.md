# App

The app is where a person sees everything Vela works on, organised as **projects**. A project is either a Lark group (tag **Lark**) or a folder on this computer (tag **Local**); both look and work the same. Inside a project, Vela answers short questions in the project chat and starts a **session** for bigger work; in a Lark project a session is a Lark topic. The app shows every project, session, routine and memory, and lets a person answer what Vela asks. It uses this system's foundations (colour, themes, type, wordmark, voice) and adds its own layout, sizes and components, all listed under the **App** groups. It reads as the same white paper, evergreen ink and mint with one vermilion signal, but quieter than the site: a sidebar of projects, a project page with its sessions panel, a conversation and a composer.

Folded in from the Vela Desktop system on 2026-11-05. Rules here win over the website's rules inside the app; the shared foundations in the main README win over both.

## Using the app components

- Every app rule in `components/bundle.css` is scoped under `.app`. Wrap an app screen or preview in `<div class="app">`. The site's rules never need the wrapper.
- App-only tokens say **App** in their usage note. A token without it is shared, and the app uses the same value as the site.
- Names that differ from the site on purpose: **StatusPill** (an app label; the site's **Pill** is a button), **StateSeal** (the app's state stamp; the site's **Seal** is decoration), type styles `app-section-title`, `app-label`, `app-code`, `app-seal`, and `bash-shadow` (the bash card; the site's `terminal-shadow` is the larger run terminal).

## Voice in the app

- **The agent speaks in the first person** and says what it will do before it does it: "I will read the retry module and its tests first." It reports results as facts: "All 14 agent tests pass and CHANGELOG.md has a new entry." (On the site Vela is spoken about; in the app it speaks.)
- **Short declaratives with a full stop** for titles: "Give Vela a task.", "Settings.". Questions only when the agent asks: "Run this command?"
- Uppercase `app-label` only for section labels and status words: `RECENT IN THIS FOLDER`, `QUEUED`, `WAITING FOR YOU`, `MEDIUM RISK`.
- **Never soften a risk.** Say exactly what a command or extension can do ("It runs with your user's permissions, outside any sandbox."). Never invent output, counts or costs: show what was recorded.
- **Names stay literal** in mono: commands, tools, paths, session ids and models (`/compact`, `read_file`, `~/code/vela`).
- **Lark, and no roles.** The chat platform is Lark. Who can reach Vela is the list of enabled chats; there are no owner or guest roles, so never show them.

## Colour in the app

- Ground is `white`; the sidebar is `sidebar`; the composer, cards and menus are `paper`. Text is `ink`, secondary text `muted`, commands and tags `teal`.
- `bubble` fills the person's messages and suggestion chips. `menu-hover` fills hovered and current rows.
- `selected` (`mint` in every theme) marks the highlighted command, palette hit, added diff lines, finished act steps and the result wedge. Text on it is `on-selected`. `diff-remove` marks removed lines.
- **Three colours, three jobs.** `accent` means *needs you*: signal marks, focus rings, the 待 seal, the edge of a session that waits for the person. `live` means *happening now*: the current act step and the running dot (`ink` in Light, `mint` in Dark). Everything else is ink and green-grey. Vermilion text uses `accent-ink`.
- **Edges.** `paper-edge` is a soft surface edge (1.3:1) and never the only edge of a control. Controls take `border-strong`, as on the site. Rows divide with `rule-list`; the header rule is `line`.
- `inverse` (with `on-inverse`, `terminal-border`, `terminal-tool`) is the bash card, a session card's step box and the channel card: dark in every theme. A raised chip on it takes `inverse-raised`, never `button-hover`, which turns light in Dark. Notes (queued, risk, lint) are `note-paper` with `note-ink`, and stay paper in Dark.
- Dialogs float over `scrim` with `dialog-shadow`.
- **Dark** follows the main README: paper and ink swap, the primary button becomes warm paper with evergreen text (hovering to `mint`), mint and vermilion keep their jobs. Surfaces climb by lightness because shadows barely show at night: `inverse`, `sidebar`, `white`, `paper`, `menu-hover`. One vermilion surface per screen.

## Type in the app

- **Text** (`sans`) for everything you read: `heading` (28px bold), `title` (20px, card and dialog questions), `body` (15/1.6, the conversation), `body-sm` (14px rows and chips), `meta` (13px), `caption` (12px key hints), `app-label` (10px caps), `button` (14px, 600).
- **Display** (`display`) only for the page title ("Give Vela a task.", 64px), the Settings title, stat figures and the wordmark.
- **Mincho** (`mincho`) only for the act glyphs and seals (`act-glyph`, `app-seal`). The font is a glyph subset.
- **Mono** for commands, output, paths, ids, models and tags: `app-code` (13/1.65), `code-sm` (12px), `tag` (11px caps, `teal`).
- Chinese and Japanese follow the main README.

## Wordmark in the app

VELA in `display` with 0.16em tracking, `teal`, over a `wordmark-offset` copy 0.04em right and down: `app-wordmark` in the sidebar, `turn-label` above each agent turn.

## Layout and shape in the app

- **Frame**: a `sidebar-width` (272px) sidebar, a `header-height` (44px) top bar over a `line` rule, the conversation at `chat-max` (720px) with the composer under it, and an optional `context-width` (320px) panel on the right. Home centres a `home-max` (760px) column.
- **All UI, so all round.** The site keeps square corners for manga panels only; the app has none. The larger the surface, the softer the corner: `radius-sm` (6px) inline code and tags; `radius-md` (8px) controls up to 40px tall; `radius-inner` (10px) boxes inside a `radius-lg` surface; `radius-paper` (12px) cards, the bash card, notes and the primary button; `radius-lg` (16px) the approval card, session cards, the command menu and dialogs; `radius-bubble` (18px, with a `radius-sm` tail toward the speaker); `radius-xl` (20px) the composer, the search palette and the result card; `radius-pill` switches, status pills and the context meter; `radius-round` dots and the avatar. An inner box always takes a smaller radius than its container.
- **Controls**: `control-sm` 32px (header), `control-md` 36px (tools, chips, rows), `control-lg` 44px (send, New session), `control-xl` 48px (approval decisions). A primary action is never under 44px.
- **Elevation**: `paper-shadow` for the composer, cards and menus, `note-shadow` for notes, `bash-shadow` for the bash card.

## States in the app

- **Focus**: a 3px solid `accent` outline at a 4px offset on every control, as on the site.
- **Hover**: rows fill `menu-hover`; the primary button fills `button-hover`; links go `teal` to `button-hover`.
- **Running**: the composer's edge turns `border-strong`, send becomes a filled stop square, and the bash card shows `running` with elapsed time.
- **Waiting for the person**: the header shows `WAITING FOR YOU` with an `accent` dot, and the approval card is the only primary action on screen.
- **Motion** only says where something came from or that its state changed. Two speeds, `duration-quick` (.2s) for small things and `duration-base` (.3s) for surfaces; everything uses `ease-out`; nothing moves more than 24px. The playable board is "Motion" on the app canvas.
  - Session panel: in at base, slides 24px from the right and fades; out at quick; the chat column resizes at once.
  - Dialog and menu: scrim fades, dialog grows from .98 and fades, a menu drops 4px from its button, all quick; leaving is opacity only.
  - Session state and checklist step: the new icon pops in from .4 scale at base with `ease-snap` (a small overshoot), the word fades at quick; a done tick pops in teal and the next step's mark pops too, no strike-through.
  - Streaming text: no per-word animation; a 2px caret blinks at the end until the turn ends; only scroll if the reader was at the bottom.
  - Tool card: height and opacity at quick, chevron turns 90°.
  - Approval card: base with `ease-snap`, rises 8px, because it needs the person. Snap is only for state icons and this card.
  - Toast: rises 12px bottom right, base in, quick out, stays 4s (longer while hovered), never covers the composer.
  - Loops: only the running dot (1.6s pulse) and the caret.
  - Not animated: switching projects, sessions, branches or settings tabs, and hover.
  - Reduced motion: every move becomes a plain fade of .2s or less, and the dot and caret stop.

## Icons in the app

**Lucide is the one icon set for the app** (2026-11-06; swapped in 2026-11-08): every icon comes from Lucide (lucide.dev, ISC, `lucide-static` 1.70), on its own 24px grid with its default 2px stroke, round caps and joins, in `currentColor`, drawn at 16-20px (so the stroke shows at about 1.4-1.7px). Do not draw icons by hand. Names in use: plus, x, check, arrow-right, chevron-down/left/right, search, house, bookmark, clock, message-square, folder, file, file-text, panel-left, panel-right, sliders-horizontal (settings), list-checks (steps), lightbulb, reply, external-link, ellipsis, paperclip, upload, copy, pencil, trash-2, git-branch, git-pull-request, wrench, chart-line, book-open, slash, wifi, battery-full, and square (filled) for stop. Icon-only buttons always carry an `aria-label`. The site keeps its own few hand-drawn icons (see Iconography).

## Projects and sessions in the app

Two words, the same everywhere (2026-11-05): a **project** is where Vela works, a **session** is one piece of work inside it. The page works like a Claude project.

- **A project has a source tag**: `Lark` (a Lark group; the chat is the group chat, people included) or `Local` (a folder on this computer; the chat is you and Vela). The sidebar lists projects under one "Projects" label with the tag on the right; there is no separate groups list or "on this computer" list.
- **The project chat is the main column**, with a composer at the bottom. People's messages are bubbles (yours on the right); Vela speaks in plain text, answers short questions there, and starts a session for bigger work. Vela's reply carries a **session card**: a state icon (? needs you, a ring for running, a dashed ring for queued, ✓ done), the title, chips for progress or what it delivered (`4/5`, `PR #274`), and, when the session needs someone, the question and an "Answer in the topic" action.
- **Sessions open in a side panel** on the right (480px), never as a separate page, so the project chat stays in view. The panel's root is the **session list**, grouped by state (Needs you, Working, Done), with the project's routines, AGENTS.md and memory below. A session shows a "Sessions › title" path, Stop and close; then its progress checklist (✓ done, ✱ now, ? waiting for an answer, ○ not started), the messages, Vela's question as a decision card (two to four options, one recommended), the files and pull requests it delivered pinned above the reply composer. A local session also has **Full view**, the full-width conversation with tool calls, approvals and the result card.
- **Two entries, like Claude on the web.** *New session* (the sidebar primary, Ctrl N) goes to the Home composer, which has a **project picker** (default: the last project used; the hint under the composer says where it runs: "Runs in ~/code/vela on this computer" or "Vela opens a topic in the Vela dev group for it, started by you"). Inside a project, its own composer starts sessions there. *New project* is the + beside the Projects label (and the last item of the picker): a dialog that picks the source, a folder (path, name) or a Lark group (from the groups the Lark app is in; creating it adds the group to the enabled chats).
- **Project settings** open from the settings icon (sliders) in the project header, as a dialog with a section list on the left (General, Instructions, Memory, Tools, Usage), like Claude's project settings. Everything there can be seen and changed at any time. General: name, the folder or Lark group, read every message (Lark), default models and thinking, Pause and Remove (what each keeps is said in words). Instructions: the folder's AGENTS.md, or the group's instructions. Tools: the project's allowed tools (for Lark, the group's tools list). Usage: tokens per session as reported.
- **Home** is one simple list: what needs you on top, then recent sessions with their project and tag, then a composer to start a session. Older sessions live in each project's **All sessions** page.
- **Lark runs inside the app** (2026-11-08: the app is the Vela SDK host). Lark projects work while Vela runs, with the window open or only in the menu bar. The sidebar brand shows `Lark · on` or `Lark · paused`; when paused, Home leads with "You paused Lark · Lark projects wait" and Resume Lark, and Lark sessions read Paused. Local projects keep working. Settings › Lark has a "Run Lark in this app" switch for people who run `vela serve` on a server or as another user instead: only one place can run a Lark app.
- **The menu bar** (board Menu bar). Closing the window keeps Vela running in the menu bar; the first close asks once (Keep running, Quit, Don't ask again), and Settings › General holds the choice (Keep running, Quit, Ask). The menu bar icon is the sail mark in four states: Online, Working (an ink dot), Needs you (an `accent` dot) and Offline (faded). Its menu shows the Lark state, what needs you, what is running, Open Vela, New session, Pause or Resume Lark, Settings and Quit. Quit with running sessions confirms first and says what stops: running sessions, Lark answers, and routines that will run once later.
- **Lark sessions ask for approval in the app** (board Lark approval). A risky command in a Lark session shows the same approval card in the session panel, and joins Home's needs-you list. Anyone in the group can approve (2026-11-08), in the app or on the approval card in the Lark topic; the first answer counts and Vela posts who approved or denied it. The command still runs on the computer running the app, with that user's permissions.
- **Who speaks in Lark.** Vela posts as the Lark bot, never as the person. A message you send from the app lands in the group or topic as the bot, signed with your name ("Vela posts it in the group, signed Alex"). Every open Lark session has an "Open the topic in Lark" link.
- **Settings › Lark** holds only the app itself (app id, secret, direct chats, the Run Lark in this app switch) and lists the Lark projects with a link to each one's project settings. Per-group switches (read every message, tools, instructions) live in project settings only, never in two places.
- **Memory is per project.** The Memory page has a project picker; shared notes are read by every project. Search (Ctrl K) finds projects, sessions, notes and commands.
- **Review the changes.** A finished local session links to a Changes view: changed files on the left, the diff on the right (added lines `selected`, removed lines a light `accent` tint), and "Ask for a change", "Copy as patch" and "Open a pull request" at the bottom.
- **Notifications.** Settings › Notifications: notify when a session needs you, finishes, or fails (on), and when someone @mentions Vela in a Lark group (off); only when the app is not in front; a badge with the needs-you count (the same number as Home); quiet hours let only questions and approvals through. Each project picks a level in project settings: needs me and finished, only needs me, or off. Clicking a notification opens the session. Notifications come from the app, also from the menu bar; a `vela serve` on a server sends none.
- **Per-project model and group instructions.** Project settings › General picks the project chat model, the session model and thinking; empty means Settings › Models. Local saves `defaultModel` and `defaultThinkingLevel` in the folder's `.vela/settings.json` (works today). Lark saves them on the group's entry in the Lark chats config (#285). Instructions are the folder's AGENTS.md, or for a Lark group the AGENTS.md in the group's workspace, `<dataDir>/channels/<group session id>/workspace/`, which the group session and every topic already discover.
- **Steps stay in reach.** A running session shows its steps in the right panel; the approval and done views keep only a `Steps · 3 of 4` chip in the header that opens them.
- **Empty and error states.** A new project opens on a short checklist of what was found (✓) and what would help (!, such as a missing AGENTS.md or group instructions), three starter asks and an empty Sessions panel. A session that stops on an error shows one card: what happened in plain words, the provider's raw message in an `inverse` box, one primary fix (Update the key, Retry), and that the session is saved. Rate limits show "Retrying · attempt 2 of 3" and a `live` dot, not the `accent` edge, because nothing is needed yet.
- **Settings pages.** General, Models, Extensions, Lark, Notifications, MCP, Permissions, Skills and Data share one left nav. Every row names the file it writes (`settings.json`, `auth.json`, `mcp.json`, trusted `.vela/` folders). A key is checked before it is saved. Risky switches say what they open, and the permission gate is shown off, as it ships.
- **Lark DM is one session, not a project** (2026-11-06). In code a DM is one long-lived channel session per chat, like a group's main session but with no topics, and `!restart` replaces it. The sidebar pins it as a "Lark DM" row under Routines; it opens like any session, with Start fresh (the same as `!restart`). Each person on the Lark owners list gets one the first time they write. Bigger work runs inline with a progress card updated in place, one thing at a time. A message sent while Vela is busy gets Queue (default), Steer or Stop, as in Lark. The right column shows what is running, the routines, your memory and who can DM Vela. A DM uses your personal memory, the same notes local projects use, never a group's. It has no project settings; its model is the default in Settings › Models.
- **All sessions, branches and forks.** Each project has an All sessions page: search over titles and messages, All / Running / Finished / Archived, grouped by day. A row's menu has Continue (open it and send a message), Rename, Fork into a new session, Duplicate, Export as HTML and Archive. Archive only hides a session from the list; its files stay and Search still finds it. In a session, a message's actions are Copy, Edit and resend (a new branch in the same session, switched with `‹ 2 / 2 ›` under the message) and Fork from here (a new session with everything above).
- **Routines** have their own sidebar page, grouped by project: what Vela should do, where it answers (the group, a topic or the DM), who set it, when, and the next run. New routine and Edit open one dialog: the message, Once (date and time) or Repeat (days and time), and where. Times use the Lark timezone. Routines run inside the app; after Vela was quit or Lark paused, each one runs its latest missed time once.
- **Images and files.** Paste, drop or attach in any composer. Images go to the model when it can see them; other files are saved in the session folder and Vela gets their path. With a text-only model the tray says so before sending. Sent attachments show as a thumbnail or a file chip above the bubble.
- **Connection and logs.** Settings › Lark shows the connection (Connected, Reconnecting, Can't connect), when Vela last heard from Lark, a problem card with one fix when something is wrong, and the last lines of the Lark log with Open full log and Copy diagnostics. Settings › Data links to the same log.
- **Settings** sits alone at the bottom of the sidebar. There is no signed-in user row: Vela has no accounts.
- One state word per session everywhere: Running, Queued, Waiting for an answer, Done, Stopped.

## Episode devices in the app

The app keeps a few devices, each with one job: **ActSteps** (起承転結) show where a run or setup is; **StateSeal** marks a state that is also written out (待 needs you, 完 done, 待機 idle), one per surface; **FirstRunHero** opens the app once, as a printed plate like the site's hero (halftone disc, VELA type, crop marks, plate label); the mint wedge tops the result card. Nothing else from the site (sound, the shot, the press animation, the finale) goes into the app.

## Open questions

- Decision cards in a session are a design: today Vela asks its question as plain text in the Lark topic. Answer buttons need Lark card actions.
- The step checklist (in the session panel and in a local session's full view) needs a plan tool in core: the model writes and updates its steps, and each change is an event. Vela has none today (main df240ed); #282 (a built-in `todo` extension, v0.6) is the plan, and until it ships the checklist is a design. It replaced the old 起承転結 run summary in the full view.
- A local project chat needs a Vela session that triages like a group session does. The likely build is one more channel on the standard channel interface (a local channel, #281 in v0.6), so Lark and Local share one runtime.
- A model per Lark group is merged (#285). Group instructions work through the workspace AGENTS.md. The app sees every session's events in its own process, so notifications need nothing from a server.
- App-only state: Archive, the Lark log file, and saving dropped files in the session folder are the app's own; Vela core has none of them. Routine edit is cancel plus create, since the routine tool only creates, lists and cancels. Custom providers and DeepSeek as a built-in provider are #289: Settings › Models and first run show a custom provider form (name, protocol, URL, key, headers, models), and DeepSeek lists deepseek-flash and deepseek-v4-pro.
- There is no "allow for this session" on the approval card, because session-scoped approval is not built (#23). Add it only when Vela has it.
- Today a Lark session has no approval UI: its confirm returns false, so risky commands are denied. The Lark approval board is the design for when the SDK hands channel approvals to the host (gap 2 in the app gap list). Pause Lark, the menu bar and "Run Lark in this app" also need the host to start and stop the Lark channel itself (gap 1).
