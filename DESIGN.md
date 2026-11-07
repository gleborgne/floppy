---
name: Floppy
description: A desktop voice assistant: a neon presence on the desktop, and quiet dark windows to configure it.
colors:
  accent: "#46e3ea"
  accent-ink: "#042326"
  accent-tint-ink: "#7ff0f4"
  accent-tint-bg: "#122a2e"
  neon-violet: "#c06bff"
  neon-cyan: "#5ee7ff"
  bg: "#0b0f15"
  panel: "#111821"
  panel-2: "#141c26"
  side: "#0e141c"
  doc-card: "#121a24"
  bubble-card: "#0d1118"
  field-well: "#0d131b"
  selected: "#16202b"
  hover: "#151e29"
  ink: "#eef8fa"
  ink-soft: "#b4c4c9"
  muted: "#9fb3b9"
  muted-2: "#8fa3a9"
  line: "rgba(255, 255, 255, 0.08)"
  edge: "rgba(120, 220, 230, 0.28)"
  bubble-line: "rgba(120, 220, 230, 0.22)"
  good: "#50e678"
  in-use: "#7ef0a8"
  warn: "#fac83c"
  warn-tint-ink: "#f3cf6b"
  warn-tint-bg: "#2a2412"
  bad: "#ff8a70"
  bad-tint-bg: "#2c1713"
typography:
  page-title:
    fontFamily: "\"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.45
  window-title:
    fontFamily: "\"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 650
    letterSpacing: "0.2px"
  detail-title:
    fontFamily: "\"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 650
  body:
    fontFamily: "\"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  body-small:
    fontFamily: "\"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.45
  section-label:
    fontFamily: "\"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 650
    letterSpacing: "1.2px"
  reading:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  reading-title:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.25
  mono:
    fontFamily: "Consolas, \"Cascadia Mono\", monospace"
    fontSize: "12.5px"
    lineHeight: 1.45
rounded:
  xs: "8px"
  sm: "9px"
  md: "10px"
  lg: "14px"
  xl: "16px"
  bubble: "18px"
  pill: "999px"
spacing:
  "2xs": "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
  "2xl": "28px"
  "3xl": "36px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "#1a2431"
  button-small:
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "30px"
  button-danger:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.bad}"
    rounded: "{rounded.md}"
    height: "36px"
  nav-item:
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "40px"
  nav-item-current:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
  card:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.xl}"
  chip:
    backgroundColor: "{colors.accent-tint-bg}"
    textColor: "{colors.accent-tint-ink}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  chip-warn:
    backgroundColor: "{colors.warn-tint-bg}"
    textColor: "{colors.warn-tint-ink}"
  chip-error:
    backgroundColor: "{colors.bad-tint-bg}"
    textColor: "{colors.bad}"
  chip-tag:
    backgroundColor: "#1a2129"
    textColor: "{colors.muted}"
  progress-bar:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.accent}"
    rounded: "999px"
    height: "6px"
  field:
    backgroundColor: "{colors.field-well}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  switch-off:
    backgroundColor: "#2a3540"
    rounded: "{rounded.pill}"
    width: "30px"
    height: "17px"
  switch-on:
    backgroundColor: "{colors.accent}"
  tab-active:
    textColor: "{colors.ink}"
    height: "40px"
    padding: "0 14px"
  bubble:
    backgroundColor: "{colors.bubble-card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.bubble}"
    padding: "10px 14px 11px"
  approval-card:
    backgroundColor: "rgba(70, 227, 234, 0.07)"
    textColor: "{colors.ink}"
    rounded: "12px"
    padding: "9px 10px"
  approval-yes:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.sm}"
    padding: "6px 0"
  document-sidebar-row-current:
    backgroundColor: "rgba(70, 227, 234, 0.12)"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
---

# Design System: Floppy

## Overview

**Creative North Star: "The Lit Presence in a Dark Room"**

Floppy has two visual registers that must never be confused. The first is the **presence**: an avatar that lives on the desktop in a transparent window, drawn in WebGL as abstract neon light (a particle swarm, a gyroscope of wire light, a glowing gel droplet, a neon oscilloscope tube, a camera iris, a pixel cat). It is the only place where glow, colour and constant motion are allowed. The second is the **workshop**: the Settings, Documents and results windows. They are calm, dark, flat and dense, built from near-black blue panels separated by hairlines, with a single cyan (`accent`) that marks what is on, selected or primary.

The speech bubble and the approval card sit between the two: they float above the avatar's head (so they carry the only real drop shadow in the system), but they use the workshop's dark panel, hairline and cyan rather than any neon of their own.

Everything in the workshop is generated, not hand-laid: Settings sections, cards, rows, tabs and forms are built at runtime from what plugins declare. The design system is therefore a small set of row, card, control and chip primitives that must compose with any plugin's content, in French or English, at any length.

**Key Characteristics:**
- Dark only (`color-scheme: dark`); there is no light theme in the build.
- One accent, cyan (`accent`), on a blue-black tonal stack (`bg` to `panel` to `panel-2` to `selected`).
- Flat, hairline-separated surfaces; shadow only on floating elements.
- Platform UI font, compact 14px body, 650 weight for titles.
- Avatars are abstract neon light with emotions and states, never emoji, face optional.
- Every visible string exists in French and English; no operating system is named in UI text.

## Colors

A blue-black workshop lit by one cyan; the neon spectrum is reserved for the avatar and the dictation pill.

Tokens live in CSS custom properties, one `:root` block per window. In the Settings window, the only `:root` is in `settings.css`; `assistant.css` and `settings-v2.css` (loaded after it) use its tokens and define none.

| Token | Defined in |
|---|---|
| `--bg`, `--panel`, `--panel-2`, `--line`, `--edge`, `--ink`, `--ink-soft`, `--muted`, `--muted-2`, `--accent`, `--accent-ink`, `--bad`, `--good`, `--warn` | `apps/desktop/src/renderer/settings.css` (Settings window, single source) |
| `--ink`, `--muted`, `--accent`, `--card`, `--line` (bubble window) | `apps/desktop/src/renderer/style.css` |
| `--bg`, `--side`, `--card`, `--line`, `--text`, `--muted`, `--accent`, `--bad` | `apps/desktop/src/renderer/documents.css` |
| `--bg`, `--card`, `--line`, `--text`, `--muted`, `--accent`, `--accent-ink` | `apps/desktop/src/renderer/panel.css` |
| `--neon`, `--neon2` | inline `<style>` in `apps/desktop/src/renderer/dictation.html` |

### Primary
- **Signal Cyan** (`accent`): the only accent. Fills the primary button, the "on" switch track, the selected segmented option, the user's own chat message and step numbers; strokes focus rings, the active tab underline, the current-row inset, the wake ring around the avatar and the listening bars. Also the colour of uppercase section labels and of links and list markers in documents.
- **Deep Cyan Ink** (`accent-ink`): text and knob colour on top of a cyan fill. Never use white on cyan.
- **Cyan Tint** (`accent-tint-bg` with `accent-tint-ink`): the default status chip ("active", "built-in"). Translucent variants of the accent (`rgba(70, 227, 234, 0.07–0.45)`) are used for tinted backgrounds and inset outlines rather than new hues.

### Secondary
- **Neon Violet** (`neon-violet`) and **Neon Cyan** (`neon-cyan`): the dictation pill only (breathing dot, gradient level bars, glow). They belong to the presence register, like the avatars' own palettes (for example `#7FE9FF` in gyre, `#7CF7FF` in essaim, cyan and magenta rings in oscillo), which each avatar plugin owns in its renderer.

### Neutral
- **Night** (`bg`): window background of Settings, Documents and the results panel.
- **Panel** (`panel`): cards, provider blocks, role cards, the assistant pane.
- **Panel Raised** (`panel-2`): secondary buttons, segmented-control well, toasts, tool rows in the assistant.
- **Sidebar** (`side`): the Documents list column.
- **Document Card** (`doc-card`): code blocks and table headers in Documents; cards in the results panel.
- **Bubble** (`bubble-card`): the speech bubble and its tail.
- **Field Well** (`field-well`): text inputs, selects and textareas in generated forms (one step darker than the panel they sit on).
- **Selected** (`selected`) and **Hover** (`hover`): current nav item and current list row; hovered list rows.
- **Ink** (`ink`): primary text. **Ink Soft** (`ink-soft`): nav labels, field labels, descriptions. **Muted** (`muted`) and **Muted 2** (`muted-2`): secondary text, hints, sub-labels.
- **Line** (`line`): neutral hairline between regions and rows. **Edge** (`edge`): the cyan-tinted border of buttons, badges and dialogs. **Bubble Line** (`bubble-line`): the bubble's border.

### Status
- **Good** (`good`): done/ok glyphs, diff additions. **In Use** (`in-use`): the "in use" badge on slot rows.
- **Warn** (`warn`, chip pair `warn-tint-bg` / `warn-tint-ink`): waiting, cloud provider, notices.
- **Bad** (`bad`, chip pair `bad-tint-bg`): errors, danger actions, refused permissions.

### Named Rules
**The One Cyan Rule.** The workshop has exactly one hue that means "this one": `accent`. A solid cyan fill marks the single primary action or the on/selected state of a control; everything else is a tint, a stroke or nothing. Do not introduce a second accent for emphasis.

**The Neon Stays Home Rule.** Glow (`box-shadow` halos), violet and gradients belong to the presence (avatars, dictation pill). Settings, Documents and the results panel never glow.

## Typography

**UI Font:** "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif (Documents and the results panel use "Segoe UI Variable", same fallbacks)
**Mono Font:** Consolas, "Cascadia Mono", monospace (Documents code uses "Cascadia Code" first)

**Character:** The platform's own interface face, used at compact desktop sizes. Hierarchy comes from weight (650 for titles, 600 for labels and buttons) and from the uppercase section label, not from a display face. On systems without Segoe the stack falls to `system-ui`, which is intended.

### Hierarchy
- **Reading title** (700, 26px, 1.25): the title of the open document in the Documents window.
- **Page title** (650, 24px): the head of each Settings section (`.page-head h2`).
- **Detail title** (650, 19px): an item's own page in Settings; dialog titles use 18px.
- **Window title** (650, 18px, 0.2px tracking): the "Settings" title in the 60px top bar.
- **Body** (400, 14px, 1.45): all workshop UI text and the bubble. Labels and row names step to 600.
- **Reading body** (400, 15px, 1.6, column max 70ch): Markdown documents. Headings inside a document: 22 / 19 / 16.5 / 15px at 650.
- **Small** (400, 12.5px): descriptions, hints, chips, secondary lines. 12px and 11px are used for chip and badge text only.
- **Section label** (650, 12px, uppercase, 1.2px tracking, `accent`): heads a group of cards in Settings (`.block > h3`, `.sgroup > h3`, `.shead`), the assistant pane title, and the permission card title (11px).
- **Mono** (12.5px, 1.45): tool output, diffs, commands, paths, test results.

### Named Rules
**The Weight Not Size Rule.** Titles are separated from body by weight 650 and a few pixels, never by a decorative face. Keep the body at 14px; do not set UI text below 11px.

**The Label Heads a Group Rule.** The uppercase cyan label names a group of cards beneath it. It never sits above a larger heading as a decorative eyebrow, and inside a tab it is hidden because the tab already names the group (`.tabpanel > .block > h3 { display: none }`).

## Layout

**Settings window.** A column: 60px top bar (title, search field up to 420px wide, actions) over a row of a 232px left navigation, a scrolling content area (padding 28px 36px 48px) and, when open, the AI assistant pane (380px in the stand-alone layout; in v2 it takes the content area as its own page). Below 760px the nav collapses to 64px showing each section's initial (`data-initial`), the form grid goes to one column and content padding drops to 20px 16px 40px. Below 900px list-and-detail layouts stack.

**Generated content.** A section is: page head (title + one sentence), then blocks of `section label` + card. Cards contain rows separated by hairlines (`srow`, `irow`, `plug`), or grids of cards (`roles` min 300px, `pgrid` min 320px, `avgrid` min 210px, `cgrid` min 260px, gap 12 to 16px). Forms are a two-column grid (gap 14px 16px); wide fields and checkboxes span both columns.

**Documents window.** A 270px sidebar (190px below 640px) and a reading column centred at max 70ch (padding 26px 34px 48px).

**Avatar window.** Transparent, 230px tall face area at the bottom, the bubble stacked above it, never taller than `calc(100vh - 236px)`; conversation scrolls inside, cards (approval, info, error) stay pinned below the conversation in their own 150px scroll area.

**Spacing rhythm.** Gaps of 8px between controls are the default; 10 to 12px between icon and label or inside rows; 16px row padding; 18 to 22px between blocks; 28 to 36px window padding. Values outside the frontmatter scale (2, 3, 5, 7, 9px) appear only inside controls for optical alignment.

## Elevation & Depth

Depth in the workshop is tonal: each layer is one step lighter blue-black (`bg` `#0b0f15`, `panel` `#111821`, `panel-2` `#141c26`, `selected` `#16202b`) and separated by a 1px hairline. Selection is shown by an inset 1px cyan outline, not by lifting. Real shadows exist only on things that float over something else.

### Shadow Vocabulary
- **Bubble float** (`box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.25)`): the speech bubble over the desktop.
- **Toast float** (`box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5)`): the Settings toast.
- **Current inset** (`box-shadow: inset 0 0 0 1px rgba(70, 227, 234, 0.35)`, 0.4 to 0.45 on list rows): current nav item, current catalogue category.
- **Picked bar** (`box-shadow: inset 3px 0 0 var(--accent)`, 2px in Documents): the chosen row in a list.
- **Dialog scrim** (`::backdrop` `rgba(0, 0, 0, 0.6)`): the editor and catalogue dialogs, which otherwise have no shadow.
- **Neon glow** (`0 0 18px rgba(192, 107, 255, .25)` and an inner cyan glow): dictation pill only.

### Named Rules
**The Flat Workshop Rule.** Settings, Documents and the results panel are flat at rest. Add a shadow only to an element that floats above other content (bubble, toast); express selection with tone or an inset line.

## Shapes

Soft rectangles throughout, radius growing with the size of the surface: 8 to 9px for small controls and fields, 10px for buttons, nav items and list rows, 14px for inner cards and result boxes, 16px for top-level cards, 18px for the bubble and dialogs, fully round (999px) for chips, badges, switches and pills. The bubble has a 14px rotated-square tail pointing at the avatar. Borders are always 1px; the only heavier strokes are the 2px focus ring, the 2px active-tab underline and the 3px wake ring. Dashed borders mark "add" placeholders and user-owned catalogue cards.

## Components

### Buttons
Compact and quiet; the cyan fill is spent on one action per view.
- **Shape:** gently rounded (10px), 36px tall, 0 14px padding, 13px at 600 (`.btn`).
- **Primary** (`.btn.pri`, also `button.primary` in the assistant and results panel): `accent` fill, `accent-ink` text, no border. Hover: `filter: brightness(1.1)`.
- **Secondary** (`.btn`): `panel-2` fill, `edge` border, `ink` text. Hover: `#1a2431`.
- **Small** (`.btn.small`): 30px tall, 0 10px, 12.5px.
- **Danger** (`.btn.danger`): secondary shape with the error colour on text and border. Destructive actions confirm in place: the button turns into "Confirm" (see the Documents trash, `.del.armed`).
- **Ghost** (`.ghost`, assistant pane): transparent with `line` border; hover tints cyan at 8%.
- **Disabled:** opacity 0.45, `cursor: not-allowed`.

### Progress bar
- **Progress bar** (`.pbar`, model library): 6px pill track in `panel-2` with a 1px `line` inset, filled with `accent` up to the value (width set through the CSSOM, never a `style` attribute: the window's CSP refuses it). `role="progressbar"` with `aria-valuenow` and the item's name as `aria-label`. Beside it, the state in 12.5px `muted-2` tabular figures ("42 % · 1,2 / 2,9 Go"). The fill moves in 250ms `ease` (off with reduced motion). During a download only the bar, its text and the button summaries are patched: the page is not redrawn, so focus and typing stay.
- **Model library** (`dialog#editor.library`): title "Models to download · For <role>", a search field (focused on open) when the plugin can search online, then section labels over cards of rows. A row: name, one sentence, grey tag chips (size, licence, memory), and on the right its buttons; "Download" and "Retry" are secondary buttons with the Lucide `download` icon (The One Cyan Rule), an error sits under the description in `bad`, "Installed" in `good` with a check, "Delete" confirms in place. A muted footer says that downloading means accepting the licence.

### Voice recorder
- **Voice recorder** (`.vrec`, the generated control for an `audio` field): a segmented control "Record myself / Import a file" (Lucide `mic`, `upload`); the sentence to read in a `field-well` block at 17px with a small "Another sentence" button; then a `panel-2` panel holding a 64px round record button (2px `accent` ring and `accent` icon at rest, filled `accent` with an `accent-ink` square while recording, so the filled cyan is spent only while it matters), the elapsed time at 22px/650 in tabular figures, live 3px level bars in `accent`, and a 6px `good` level meter (its fill moves with `transform: scaleX`, never `width`). Three numbered tips sit below (one column under 760px). After recording: a round play button, the waveform, the length, then checks as a wrapped list, each with a Lucide `check` in `good` or `triangle-alert` in `warn`; "Start over" is a small secondary button. Errors use `bad` with `role="alert"`. Sizes and the meter width are set through the CSSOM (CSP). The meter transition is off with reduced motion.
- **Play lead** (`.vplay`): a 32px round secondary button with the Lucide `play` icon at the start of a row whose item has a `play` action ("Listen"), or beside the current recording; its accessible name says what plays. One sound plays at a time.
- **Trial player**: after a trial that returns a sound, a native `<audio controls>` (max 420px) under the result text, so the sound can be replayed.
- **Folded group** (`.sfold`): in a grouped slot list, a group of more than six items shows only the one in use and a muted line "N more in <group>" with a small "See" button (`aria-expanded`).

### Toggles (switches)
- **Switch** (`.sw`, the only switch): 30 by 17px track, `track` off with a `muted-2` knob; `accent` on with an `accent-ink` knob; knob slides in 120ms. Always `role="switch"` with `aria-checked` and an `aria-label` that names the item and its state.

### Segmented control
- `panel-2` well, 3px padding, 11px radius; options are 8px-radius buttons in `muted`; the selected option is filled `accent` with `accent-ink` at 650. Exposed as `role="radiogroup"` with `role="radio"` options.

### Chips and badges
- **Status chip** (`.chip`): pill, 12px, filled tint, no border: cyan tint by default, amber tint for `cloud` and `warn`, red tint for `err`, grey for plain tags.
- **In use** (`.inuse`): pill, 28px tall, green text on a 10% green tint with a 7px dot.
- **Choice chips** (`.chips button`, documents filters `.chip`, assistant suggestions `.suggest`): outlined pills in `muted`; hover or selected turns the border (and text) cyan; selected filters also take a 14% cyan tint.
- **Nav badge** (`.badge`): 11px outlined pill, `edge` border, pushed right.

### Cards / Containers
- **Corner Style:** 16px for top-level cards, 14px for nested ones.
- **Background:** `panel` on `bg`.
- **Shadow Strategy:** none (see Flat Workshop Rule).
- **Border:** 1px `line`; an active or main card raises its border to cyan at 0.35 to 0.45 alpha.
- **Internal Padding:** rows 10px 18px or 12px 16px; standalone cards 12 to 16px.
- **Disabled / sleeping content** drops to opacity 0.55 to 0.62 and returns to full on hover or focus.

### Inputs / Fields
- **Style:** `field-well` background, 1px `rgba(255, 255, 255, 0.12)` border, 9px radius, 8px 10px padding, 13px text; label above in `ink-soft` 13px, hint below in `muted-2` 12px, required mark in `accent`.
- **Search:** 36px tall, 10px radius, magnifier icon at 16px; the border turns `accent` on `:focus-within`.
- **Range:** 6px track filled with `accent` up to the value (`--fill`), 16px thumb in `ink` with a 2px cyan ring; value shown beside it in tabular figures, cyan.
- **Forms are generated** from plugin declarations: each declared setting type maps to one control (enum to segmented control or select, boolean to switch, number to range, text to text field, list to chips). Do not hand-build a one-off form.
- **List chips** (`.lchips` / `.lchip`): the field well holds one 28px pill per value (`panel-2` fill, `edge` border, 13px `ink`) with a round × button, then a borderless text input; Enter or a comma adds, a multi-line paste adds several, duplicates are ignored. The well's border turns `accent` on `:focus-within`.
- **In-place form** (`.iform`, an item's page or a single-item plugin tab): the item's fields sit directly on the page in a 14px card and save themselves on each finished change. "✓ Saved" (12px, `good`) shows top right for 2.5s, "Saving…" in `muted-2`; an error or an empty required field shows under the form in `bad` and nothing is sent. There is no Edit button: the editor dialog only adds items. A successful add closes the dialog and says so in the toast (never a second "Close" step); a failed add keeps the dialog and its values, with the error under the form in `bad`.

### Navigation
- **Left nav** (`.nav`): 40px rows, 10px radius, `ink-soft` 14px text with an optional second line in 11.5px `muted-2`; hover `rgba(255, 255, 255, 0.04)`; current (`aria-current="page"`) uses `selected` with a cyan inset outline. A muted note sits at the bottom.
- **Tabs** (`.ptabs` / `.ptab`): 40px, 14px at 600, `muted` text; the active tab turns `ink` with a 2px cyan underline inset 10px from each side. Exposed with `role="tablist"`, `role="tab"`, `aria-selected` and roving `tabindex`. A group of only one or two settings (`data-light`, e.g. Tone under Voice) never gets a tab of its own: it stays on the page, below the tab panel, and a page left with a single tab shows no tab bar.
- **Step chain** (`.ptabs.chain` / `.ptab.pstep`): when every slot of a section declares a `step` (e.g. Listening: speech detector → transcription → wake word), their tabs become equal cards (`panel`, 12px radius, 10px 14px padding) joined by Lucide `arrow-right` icons in `faint`: a 12px `muted-2` line "n · role" over the item in use in 14px `ink`. The open step takes `selected` with the cyan inset outline (no underline); its first line turns `accent`. Other tabs (Plugins) follow as plain tabs. Below 760px the cards stack and the arrows hide.
- **Breadcrumbs** (`.crumbs`): a small "Back" button, then cyan text links separated by `›`, the current page in `ink` with `aria-current="page"`.
- **Clickable rows** (`.srow.pick`): the whole row opens the detail, shows a chevron that turns cyan on hover, and has an inset focus ring.
- **Tool logo** (`.srow .lg`): a 32px slot at the start of a row holding the tool's real logo at 26px, in its own colours, with no tile behind it (`ItemInfo.logo`, see `docs/spec/elements.md`). In a list where any row has a logo, rows without one show their initial in the same slot (8px radius, `sunken`, `muted-2`, 14px/650) so names stay aligned. A turned-off row shows its logo in greyscale at 55% opacity. The detail page repeats the logo in its head row. `aria-hidden`: the name beside it is the label.

### Speech bubble (signature)
- `bubble-card` fill, `bubble-line` border, 18px radius, tail pointing down at the face, Bubble float shadow. Shows "You:" in `muted` 12.5px with a cyan bold prefix, then the reply in `ink` 14px; hairlines at 6% white separate the parts. Appears and hides with a 180ms fade plus 8px rise. The listening state shows "I'm listening…" in cyan with four bars driven by the microphone level.

### Approval card (signature)
- Inside the bubble, below the conversation: 12px radius, `rgba(70, 227, 234, 0.07)` fill and 0.3 cyan border; title in 12px cyan at 600, text at 13px. Two equal buttons side by side, 9px radius: "Yes" filled `accent`, the other neutral at 6% white. A 2px cyan bar under the buttons shrinks from full width to zero over the request's time-to-live. Variants: `info` (neutral fill, `line` border) and `error` (red tint, red title). In the assistant pane the equivalent permission card (`.perm`) uses a cyan 1px border on `panel-2` and drops to `line` once answered.

### Documents
- Sidebar of rows (title clamped to two lines at 14px/600, date in 12px `muted`); current row has a 12% cyan tint and a 2px cyan left bar; a trash button appears on hover, focus or when armed, and arming turns it red with a "Confirm" label. The reading column renders Markdown: cyan links with 3px underline offset, cyan list markers, block quotes with a 3px cyan-at-50% left rule, code and tables on `doc-card`, zebra rows at 2.5% white.

### Results panel
- Renders cards (`doc-card`, 14px radius, `line` border) with headings `.h1` to `.h5` (24 / 20 / 17 / 15.5 / 14px at 650), captions in 12.5px `muted`, and buttons following the secondary/primary pattern (34px tall).

### Dictation pill
- A floating pill (999px radius, `rgba(14, 12, 24, .92)`, violet hairline and glow): a breathing violet dot that flashes cyan when words are typed, gradient level bars that follow the voice, and a round stop button.

### Iconography
- Icons are **Lucide** (ISC licence), copied path-for-path from `lucide-static` v1.59.0 into `apps/desktop/src/renderer/icons.ts` and built as DOM SVG by `window.lucideIcon(name)`: 24 viewBox, `stroke="currentColor"`, stroke-width 2, round caps and joins, `aria-hidden="true"`, sized in CSS (16px in buttons). The button around an icon carries the accessible name. Inline SVG in HTML follows the same attributes (search magnifier in `settings.html`). Add an icon by copying its paths from the same Lucide version; record it in `THIRD_PARTY.md` if a new source is ever used.
- **Brand logos** are the one exception: a connector or app row shows the real logo of the tool it stands for (Tool logo, above), in the brand's own colours. Logos come from the tool itself (an MCP server's icon, a program's icon) or ship with the plugin from a source whose terms allow it (Simple Icons CC0, the vendor's official icon set), recorded in `THIRD_PARTY.md`. Never redraw, recolour or crop a logo, and never use one as a button icon or decoration.

### Motion
- **State transitions:** 120 to 180ms, `ease` (switch knob 120 to 140ms, bubble 180ms, toast 160ms, trash reveal 120ms).
- **Page entry:** the slide or fade of a Settings page plays once per navigation (section, item page, tab), never on a data refresh; a refresh that shows nothing new leaves the page untouched.
- **Navigation:** pages enter with 200ms `cubic-bezier(.2, .7, .2, 1)` and an 18px horizontal slide (forward from the right, back from the left); fades are 180ms with a 6px rise; tab panels fade in 150ms.
- **Presence signals:** wake ring (150px cyan circle scaling 0.6 to 1.5 and fading over 700ms ease-out), listening bars (1.1s pulse, heights follow `--lvl`), loading dot pulse 1s, spinner 0.8s linear, dictation breathe 1.6s.
- **Reduced motion:** every window honours `prefers-reduced-motion: reduce` (transitions and page animations off, wake ring and bars stopped), and avatars receive `reducedMotion` in `create()` and must damp breathing, nods, kicks and speed.

### Avatars (signature)
- **Principles:** abstract, neon, 3D-feeling light on a dark ground; a face is optional (gyre has none, iris is a single eye, essaim forms a face only for a moment); never emoji, never a flat cartoon sticker. Each avatar owns its own palette inside its renderer, typically cool cyans with a second neon hue.
- **They express, they do not decorate.** The kernel sends the same states (`sleep`, `idle`, `listening`, `thinking`, `speaking`), emotions with intensity and duration, a mood (valence, energy) and short cues (`nod`, `perk`, `startle`, `wake`). Every avatar renders all of them in its own idiom: listening opens up toward the microphone, thinking looks up or orbits, speaking follows the real voice level, sleep closes or settles.
- **Interface:** `plugins/avatar/<id>/renderer/index.js` exports `create(container, { reducedMotion })` returning `setState`, `setEmotion(name, intensity, ms)`, `setLevel`, and optionally `setMood`, `lookAt`, `setHearing`, `cue`, `destroy`. `avatar.json` declares `id`, `name { fr, en }`, `description { fr, en }` and the `emotions` actually drawn; undrawn emotions fall back to the nearest one.
- **Alive, not busy:** parameters follow targets like soft springs (small overshoot), strong emotions start with a squash then a jump, breathing and blinking continue at rest.
- Reference sheets: `docs/spec/img/avatar-emotions.png`, `docs/spec/img/avatar-states.png`, `docs/spec/corps-et-avatar.md`.

### Accessibility facts (verified in the source)
- **Contrast on dark** (WCAG ratio): `ink` on `bg` 17.8; `muted` on `bg` 8.8 and on `panel` 8.2; `muted-2` on `panel` 6.8; `accent` on `panel` 11.4; `accent-ink` on `accent` 10.6; `bad` on `panel` 7.8; `warn` on `panel` 11.4; cyan chip 11.2; amber chip 10.3. The breadcrumb separator and chevron colour `#5d6f76` is 3.4 on `panel` and is only used on `aria-hidden` decoration.
- **Focus:** a global `:focus-visible` ring (2px `accent`, 2px offset) in Settings, Documents, the results panel and the approval card buttons; list rows use an inset ring. The search field shows focus through its border instead of a ring.
- **Semantics:** switches use `role="switch"` and `aria-checked`; segmented controls are radiogroups; tabs follow the tablist pattern; the bubble, document view and results panel are `aria-live="polite"`; the toast is `role="status"`; provider errors use `role="alert"`; nav regions are labelled; decorative glyphs and icons are `aria-hidden`.
- **Language:** each window starts with `lang="fr"` and sets `document.documentElement.lang` to the active language at runtime.

## Do's and Don'ts

### Do:
- **Do** use the tokens from the window's `:root` (`var(--accent)`, `var(--panel)`, `var(--line)`…) rather than new hex values; in Settings, add new tokens to the `:root` of `settings.css`, the single source.
- **Do** keep one filled-cyan action per view (The One Cyan Rule) and use the secondary `.btn` for everything else.
- **Do** give every visible string a French and an English version: window texts go in the window's `{ fr: {…}, en: {…} }` table and are read through its helper (`t()` in Settings, `L()` in the avatar window); plugin code writes user text with `T("…fr…", "…en…")` from `@floppy/core` (labels, descriptions, approval summaries, errors via `TextError`), which reaches the window as `{ fr, en }` and is resolved with `tr()`; windows opened by a plugin read `ctx.uiLang()`. Insert kernel text with `textContent`, never `innerHTML`.
- **Do** write keyboard shortcuts as `Ctrl+Alt+…` in source strings; the renderer rewrites `Ctrl+Alt+` to `⌃⌥` on macOS (`app.ts`, `dictation.ts`). Name no operating system in UI text.
- **Do** build new icons from Lucide paths through `lucideIcon()`, `aria-hidden`, with the name on the button.
- **Do** honour `prefers-reduced-motion` in every new animation, and pass `reducedMotion` through to avatar renderers.
- **Do** make new avatars abstract neon light that renders every state and emotion, with `name` and `description` in `{ fr, en }`.

### Don't:
- **Don't** add a light theme or light surfaces piecemeal; the build is dark only.
- **Don't** add glow, gradients or violet to Settings, Documents or the results panel (The Neon Stays Home Rule).
- **Don't** add drop shadows to cards; selection is a tone step or a 1px cyan inset (The Flat Workshop Rule).
- **Don't** put white text on cyan; use `accent-ink`.
- **Don't** place an uppercase label above a heading as an eyebrow or kicker; the uppercase label only names a group of cards.
- **Don't** use emoji or text glyphs as icons in new UI; existing ones are listed below as debt.
- **Don't** use brand logos anywhere but the Tool logo slot of the row for that tool.
- **Don't** write "Windows", "macOS", "Cmd" or "Option" in UI strings.

### Known inconsistencies in the shipped CSS (not rules)
- **Font stacks differ slightly:** "Segoe UI Variable Text" (avatar, Settings, dictation pill) and "Segoe UI Variable" (Documents, results panel); all end with `system-ui, sans-serif`, so other systems use their own UI font.

### Avatar previews
- Settings shows a still preview of each avatar (`plugins/avatar/<id>/renderer/preview.png`, 168px, captured in the idle state on `code-bg`). Rebuild them after adding or redrawing an avatar: `npm run avatar-previews -w @floppy/desktop`.
