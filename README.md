# walkreel

Demo videos of web app features, from a short YAML storyboard.

Walkreel is a Claude skill that turns "show how to create a project in our app" into a polished, ready-to-share MP4, usually in one to two minutes.

It drives your web app in a real Chromium browser, records it, and then post-produces the footage in a fixed house style:

- a shadowed browser window on a gradient background in your app's own colors, with your production domain in the address bar
- smooth zooms on the fields being filled and on the final result
- a synthetic cursor with press effect and click rings
- short captions, a title card and a fade out
- optional, very quiet acoustic-guitar background music (you're asked once per project), plus a single click sound on submit
- landscape (16:9), vertical (9:16) and square (1:1) output from the same storyboard

Every step is a line of YAML, so a video can be regenerated in seconds after the UI changes, without a model.

## Install

```bash
npx walkreel install
```

This copies the skill to `~/.claude/skills/walkreel`, installs its dependencies and Chromium, and checks the rest. Use `--project` to install it for the current project only (`./.claude/skills/walkreel`).

Two things can't come from npm; the installer tells you if they're missing:

- Python 3 with `opencv-python-headless numpy pillow` (`python3 -m pip install opencv-python-headless numpy pillow`)
- `ffmpeg` with libx264 and aac (any standard build): `brew install ffmpeg`, `sudo apt install ffmpeg` or `winget install ffmpeg`

Run `npx walkreel doctor` any time to re-check.

<details><summary>Install from git instead</summary>

```bash
git clone https://github.com/ragaslan/walkreel.git ~/.claude/skills/walkreel
cd ~/.claude/skills/walkreel && npm install && npx playwright install chromium
node scripts/doctor.mjs
```
</details>

## Use it

Start your app locally with seed/demo data, then ask Claude in any language:

> Make a video showing how to add a new contact.

The first time, Claude creates `.demo-video/config.yaml` in your project (base URL plus the login steps for a **test** account), maps the app once, writes a storyboard, records and renders. Later videos reuse the cached map and session.

## Run it by hand

From your project root:

```bash
node ~/.claude/skills/walkreel/scripts/discover.mjs                 # map the app (cached)
node ~/.claude/skills/walkreel/scripts/record.mjs storyboard.yaml --out .demo-video/out/demo \
  && python3 ~/.claude/skills/walkreel/scripts/render.py .demo-video/out/demo -o demo.mp4
```

Add `--format vertical` or `--format square` to `record.mjs` for social clips.

## A storyboard

```yaml
title: Creating a project
subtitle: Acme CRM
vars:
  project: Mobile app launch
steps:
  - goto: "/projects"
    caption: Open Projects
  - click: { role: button, name: "＋ New project" }
    caption: Click New project
  - type: { target: { label: Project name }, value: "{{project}}" }
    caption: Name the project
  - select: { target: { label: Owner }, option: Marcus Reed }
  - click: { role: button, name: Create project }
    caption: Create the project
  - waitFor: { text: Project created }
    zoom: { role: cell, name: "{{project}}" }
    caption: The new project is listed
teardown:                       # not in the video: remove what the recording created
  - goto: "/projects"
  - click: { role: button, name: Delete, within: { role: row, hasText: "{{project}}" } }
```

[SKILL.md](SKILL.md) is the full reference (actions, targets, setup/teardown, variables, formats, style). [examples/](examples) has a self-contained mock app with two storyboards:

```bash
python3 -m http.server 5173 -d examples/mock-app      # in one terminal
cd examples && node ../scripts/record.mjs new-project.yaml --out .demo-video/out/new-project \
  && python3 ../scripts/render.py .demo-video/out/new-project -o new-project.mp4
```

## Good to know

- **Test accounts only.** Login steps live in `.demo-video/config.yaml`; never put a real user's password there. The cached session (`auth.json`) and recordings are git-ignored automatically.
- **Recording creates real data.** Give storyboards that create records a `teardown:` so repeated runs don't pile up duplicates.
- **Failures are explained.** A failed recording prints the failing step, an accessibility snapshot, a screenshot, and any requests still waiting for the server. It also refuses to render a stale previous recording.
- **Your colors, automatically.** The app's main color is read from the page and the video's palette is derived from it; set `brandColor` in the config to override.
- **Quiet on purpose.** Only the submitting click makes a sound. Music is opt-in (`music: true` in the config, `--music on|off` at render time) and stays in the background: the same soft guitar loop for every video.

## License

MIT © 2026 Ramazan Agaslan. See [LICENSE](LICENSE).

## Credits

- Inter typeface by Rasmus Andersson, SIL Open Font License (`assets/fonts/LICENSE-Inter.txt`).
- Background music and sound effects are synthesized by the code in this repository (`scripts/make_music.py`, `scripts/render.py`).
