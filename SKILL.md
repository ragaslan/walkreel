---
name: walkreel
description: Produces a short, polished "how to" demo video (MP4) of one feature of a web app — real browser recording with smooth zooms, a synthetic cursor, captions, colors taken from the app itself, optional quiet background music and a minimal click sound on submit. Use when the user asks in any language for a video that shows how to do X in their app, a feature walkthrough, onboarding or tutorial clip, product demo, or a vertical/square clip for social media. Web apps only.
---

# Walkreel

Natural-language request → app map (cached) → storyboard (YAML) → recording in a real browser → fixed-style post-production → MP4.

**Goal: a finished video 1–2 minutes after the request.** So:
- Don't explore the app step by step in a browser. `discover.mjs` builds the map in one go and caches it; write the storyboard from that map **in one pass**.
- Don't ask for approval before recording. Produce the video, then ask "anything you'd like to change?". Re-recording is cheap.
- Login happens once; the session is cached in `.demo-video/auth.json`.

```
walkreel/
├── SKILL.md
├── config/style.json        # the fixed look: zoom, cursor, captions, sound, music, colors, formats, languages
├── scripts/doctor.mjs       # one-shot install check, prints the fix for anything missing
├── scripts/discover.mjs     # app map + login cache (.demo-video/)
├── scripts/record.mjs       # plays the storyboard, records frames + timeline (+ --inspect)
├── scripts/render.py        # zoom/pan, cursor, effects, captions, audio -> MP4
├── scripts/make_music.py    # regenerates the single music bed (not needed for normal use)
├── scripts/lib.mjs          # shared code
├── assets/fonts/            # Inter (OFL)
├── assets/music/theme.m4a   # the one background track (synthesized, license-free)
└── examples/                # mock app, sample .demo-video/, sample storyboards
```

## Requirements (check once, on first use)

```bash
node <skill>/scripts/doctor.mjs
```

It checks Node 18+, the npm packages, Playwright Chromium, Python 3 with opencv/numpy/pillow, and ffmpeg with libx264 + aac, then prints the exact install command for anything missing. Install with the user's consent, then re-run it.

Always run the scripts **from the user's project root** (`node <skill>/scripts/...`); the `.demo-video/` folder is found from there. The app must be reachable from this machine — ideally a local dev server with seed data. Both `discover` and `record` check that the server answers before starting and stop with a clear message if it doesn't.

## Workflow

### 1. Project config (once per project)
If `.demo-video/config.yaml` doesn't exist in the project root, create it. Ask for anything missing in a single message — and **always ask whether they want background music** (soft acoustic guitar, stays in the background); not everyone does. Save the answer as `music: true/false` so it's never asked again:

```yaml
baseUrl: http://localhost:3000
language: en                       # caption language (en, tr, de; add more under i18n in style.json)
displayUrl: app.example.com        # optional; shown in the video's address bar instead of localhost (path kept)
brandColor: "#2563eb"              # optional; otherwise the app's main color is read from the page
music: true                        # the user's answer to "background music?" (ask once, then keep)
hide: [".cookie-banner", "#intercom-container"]   # optional; elements kept out of the video
login:                             # optional; TEST/DEMO accounts only
  - goto: /login
  - type: { target: { label: Email }, value: demo@example.test }
  - type: { target: { label: Password }, value: demo1234 }
  - click: { role: button, name: Sign in }
crawl:                             # optional
  maxPages: 25
  start: [/]                       # extra starting paths
  exclude: [/admin/logs]           # URLs containing these are not visited
```

- **Never ask for or type a real user's password.** Only seed or demo accounts in a local/test environment.
- No real customer data may appear in the video. Prefer a test environment filled with seed data.
- Don't know the login form labels? Look at the login page in the project's source, or run `discover.mjs` once without `login`; the sign-in fields show up in the map.
- An existing config without a `music:` line means the question was never asked: ask it before the next video and add the line (`record.mjs` prints a note when it's missing).
- `.demo-video/.gitignore` is created automatically (ignores `auth.json` and `out/`); config and storyboards can be committed.
- Dev-server badges (Next.js, Vite) are always hidden; use `hide` for anything else (chat widgets, cookie banners, environment ribbons).

### 2. Get the map

```bash
node <skill>/scripts/discover.mjs          # cached: <1 s, no browser
```

Then read `.demo-video/app-map.md`. For each page it lists: how to reach it, links, buttons, form fields (with input type and select options), table columns, and the dialogs that "New/Add" buttons open. Names are Playwright accessible names; use them verbatim as targets.

- The first crawl takes a few seconds to ~1 minute. It never clicks Save/Delete/Send-like buttons and never submits forms.
- Feature not in the map (e.g. a page behind a row click)? Add it with `--only <path>`, or run a draft storyboard with `record.mjs --inspect --upto N`.
- If the project's source is at hand, its routes and form components are a quick way to fill gaps in the map.

### 3. Write the storyboard (in one pass)
With a project config, `app` isn't needed:

```yaml
title: Adding a new contact        # shown on the title card
subtitle: Acme CRM                  # optional
# language: de                      # optional, overrides the config
# format: vertical                  # optional: landscape (default) | vertical (9:16) | square (1:1)
# music: false                      # optional, overrides the config for this video
steps:
  - goto: "/contacts"               # if the first step is goto, the video starts with the page loaded
    caption: Open Contacts
  - click: { role: link, name: "＋ New contact" }
    caption: Click New contact
  - type: { target: { label: Full name }, value: Priya Raman }
    caption: Enter the name
  - select: { target: { label: Company }, option: Kestrel Logistics }
  - click: { role: button, name: Save }
    caption: Save the contact
  - waitFor: { text: Contact saved }
    zoom: { role: cell, name: Priya Raman }   # zoom in on the result
    caption: The contact is in the list
    hold: 600
```

For one-off jobs without a project config, add `app: { baseUrl: ... }` to the storyboard.

**Steps that stay out of the video, and variables.** Recording creates real data. So that re-running the same storyboard doesn't pile up duplicates, give every storyboard that creates data a `teardown`:

```yaml
vars:
  name: "Priya Raman"               # used as {{name}} in steps and teardown
setup:                              # before recording, fast mode (not in the video)
  - goto: /contacts                 # delete a leftover from an earlier failed run; skipped if absent
  - click: { role: button, name: Delete, within: { role: row, hasText: "{{name}}" } }
    optional: true
steps:
  - type: { target: { label: Full name }, value: "{{name}}" }
  # ...
teardown:                           # after recording; runs even if the recording failed
  - goto: /contacts                 # always start with a goto (the page may be half-way through something)
  - click: { role: button, name: Delete, within: { role: row, hasText: "{{name}}" } }
  - click: { role: button, name: Delete }       # the confirmation dialog
  - waitFor: { text: deleted }
```

- A setup/teardown step with `optional: true` is skipped if it fails (3 s timeout). Consecutive optional steps form a chain: once one fails, the rest of the chain is skipped without waiting. A teardown failure never breaks the recording; it's printed as a warning.
- The browser's native `confirm()` / `alert()` dialogs are accepted automatically.
- Built-in variables: `{{run}}` (4 characters unique to this run), `{{date}}` (YYYY-MM-DD), `{{time}}` (HH:MM). If no teardown is possible (no delete UI), use `{{run}}` for unique names, but remember it shows in the video. Unknown variables are an error.

**Actions** (exactly one per step):

| Action | Form | Notes |
|---|---|---|
| `goto` | `"/path"` or a full URL | resolved against baseUrl |
| `click` / `check` | target | cursor travels, clicks, ripple |
| `hover` | target | |
| `type` | `{target, value, clear?, enter?}` | clears the field first; for date/time inputs give `YYYY-MM-DD` / `HH:MM` |
| `select` | `{target, option}` | native `<select>`: the video shows a look-alike list opening and the cursor picking the option (the OS popup itself can't be recorded); custom dropdowns are `click` steps |
| `press` | `"Enter"`, `"Escape"` | |
| `scroll` | `400` or `{to: target}` | smooth scroll |
| `waitFor` | `{text: ...}` / `{url: "regex"}` / target | waiting is compressed in the video |
| `wait` | ms | hold the scene |

**Targets:** `{role, name}` → `{label}` → `{placeholder}` → `{text}` → `{testId}` → `{css}`. Extras: `exact: true`, `nth: 1`, `hasText`, `within: <target>`, `global: true`. **When a dialog/modal is open, targets are looked up inside the topmost dialog first**, then in the whole page — same-labelled filters behind the dialog are never picked. `within` or `global: true` turns this off. Map entry `button "＋ New project"` → `{ role: button, name: "＋ New project" }`, `textbox "Full name"` → `{ label: Full name }`.

Elements are scrolled into view automatically, including when they're visible but covered by a sticky header or a dialog footer.

**Step fields:** `caption` (stays until the next caption; `""` hides it), `zoom` (`true`/`false`/a target; by default `type` and `select` steps zoom in), `hold` (ms), `sound` (`true`/`false`; force the click sound on/off for this step).

**Rules:**
- Aim for 15–40 s and at most ~12 steps. Focus on the core of the feature and take the shortest route (the map's "how to reach" line). If useful, start with a `goto` straight to the target page.
- Captions are short and imperative, ~8 words max. Group consecutive similar fields under one caption.
- Show the outcome: wait for the success message in the last step and `zoom` on the created record. Prefer a cell over a very wide element like a whole table row.
- Fill only the fields the task needs. Values should be realistic but made up.

### 4. Record and render

```bash
node <skill>/scripts/record.mjs storyboard.yaml --out .demo-video/out/<name> \
  && python3 <skill>/scripts/render.py .demo-video/out/<name> -o <name>.mp4 --stills .demo-video/out/<name>/stills
```

`--format vertical|square` on `record.mjs` (or `format:` in the storyboard) records a 9:16 or 1:1 clip. The format must be chosen at record time: it sets the browser viewport, so the app lays out for that width (vertical uses a 430px mobile layout and reserves a caption band below the window).

If recording fails, the script prints the failing step, the aria snapshot at that moment, `failure.png`, and — when relevant — requests still waiting for a response (a hung server), recent HTTP errors and console errors. It exits with code 2 and the previous `timeline.json` is deleted, so `render.py` refuses to render instead of silently turning the previous recording into a video. Chain the commands with `&&`; piping output into something like `| head` loses the exit code. Fix the target and run again. If the UI changed: `discover.mjs --refresh` (or `--only <path>`).

### 5. Quick check and delivery
If it's the first video for this project, look at 3–4 of the `--stills` frames with Read: is the zoom on the right area, does a caption cover something important, is any real personal data visible? Later videos can skip this.

Send the MP4, state its length in one line, and ask whether they want changes. Keep the storyboard in the project (e.g. `.demo-video/storyboards/`); when the UI changes, the same file regenerates the video without a model.

Visual-only changes don't need a new recording: `render.py ... --style override.json` (a *partial* JSON; it's merged over the recorded style). `--music on|off` switches the music for that render (e.g. the user changed their mind). `--gif` also writes a GIF.

## The fixed style

Every video uses the same `config/style.json`: a shadowed browser window (with address bar) on a gradient background in the app's own colors, easeInOutCubic zoom in/out/pan, zooming in on fields while typing, a synthetic cursor with press effect, a click ring, bottom-center captions, a title card (a localized "How it works" kicker, the title and the app name in readable sizes), a fade out, compressed page loads and sped-up typing.

**Sound is sparse on purpose.** By default only the click that submits a form makes a sound (a real submit button, or a button whose name contains one of `i18n.<lang>.submitWords`; if none is found, the last button click). The whoosh plays once, on the title card transition. `sfx.clicks`: `submit` | `actions` | `all` | `none`; `sfx.whoosh`: `intro` | `all` | `none`.

**Colors come from the app.** While recording, the app's main color is read from the first page (primary button backgrounds, `--primary`/`--brand`/`--accent` CSS variables, `<meta name="theme-color">`); the background gradient, the click ring and the title card tint are derived from it, always deep enough for white text. If no clear color is found (a gray UI), a neutral slate palette is used. Set `brandColor` in the config or storyboard to force one; any explicit color in `style.json` (instead of `"auto"`) also wins.

**Music (optional, the user decides):** one fixed, synthesized track (`assets/music/theme.m4a`: softly finger-picked nylon guitar over a quiet bass in a small dry room; no melody, drums, pads or big reverb; 24 s seamless loop) plays very quietly (~-30 LUFS) with a soft fade in/out — only when the user said yes. It is deliberately the same for everyone and not configurable beyond on/off and `music.volume`. Don't swap in other tracks.

Per-video tweaks go in the storyboard's `style:` key.
