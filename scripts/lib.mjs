// Shared code for record.mjs and discover.mjs: target resolution, step runner,
// browser launch, project config (.demo-video/) and the session cache.
import { chromium } from 'playwright';
import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ACTIONS = ['goto', 'click', 'type', 'select', 'press', 'hover', 'scroll', 'wait', 'waitFor', 'check'];
export const TARGET_KEYS = ['role', 'label', 'placeholder', 'text', 'testId', 'css'];

// ---------------------------------------------------------------- helpers
export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
export const now = () => Date.now() / 1000;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2); // easeInOutCubic, same as render.py

export function deepMerge(base, over) {
  if (over === undefined || over === null) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

export function actionOf(step) {
  return ACTIONS.find((k) => k in step);
}

export function describeTarget(t) {
  return typeof t === 'string' ? `text="${t}"` : JSON.stringify(t);
}

// Turns a target definition into a Playwright locator.
// string -> visible text; object -> role/label/placeholder/text/testId/css (+ name, exact, nth, within, hasText)
export function resolveTarget(page, t) {
  if (t === undefined || t === null) throw new Error('Target is not defined.');
  if (typeof t === 'string') return page.getByText(t, { exact: false }).first();
  const scope = t.within ? resolveTarget(page, t.within) : page;
  let loc;
  if (t.role) loc = scope.getByRole(t.role, { name: t.name, exact: t.exact ?? false });
  else if (t.label) loc = scope.getByLabel(t.label, { exact: t.exact ?? false });
  else if (t.placeholder) loc = scope.getByPlaceholder(t.placeholder, { exact: t.exact ?? false });
  else if (t.text) loc = scope.getByText(t.text, { exact: t.exact ?? false });
  else if (t.testId) loc = scope.getByTestId(t.testId);
  else if (t.css) loc = scope.locator(t.css);
  else throw new Error(`A target needs one of these keys: ${TARGET_KEYS.join(', ')}`);
  if (t.hasText) loc = loc.filter({ hasText: t.hasText });
  return typeof t.nth === 'number' ? loc.nth(t.nth) : loc.first();
}

// If a dialog is open, looks for the target inside it first (topmost = last in the DOM),
// then falls back to the whole page. Keeps same-labelled elements behind the dialog
// (e.g. filter boxes) from being picked. Disabled when `within` is given or
// `global: true` is set.
export async function locateTarget(page, t) {
  if (t && typeof t === 'object' && (t.within || t.global)) return resolveTarget(page, t);
  const dialogs = page.getByRole('dialog').or(page.getByRole('alertdialog'));
  const n = await dialogs.count().catch(() => 0);
  for (let i = n - 1; i >= 0; i--) {
    const d = dialogs.nth(i);
    if (!(await d.isVisible().catch(() => false))) continue;
    const loc = resolveTarget(d, t);
    if ((await loc.count().catch(() => 0)) > 0) return loc;
  }
  return resolveTarget(page, t);
}

// Fills "{{name}}" placeholders in the storyboard (setup/steps/teardown, every string).
// Unknown variables are an error so a typo never ends up silently in the video.
export function applyVars(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k) => {
      if (!(k in vars)) throw new Error(`Unknown variable: {{${k}}} (defined: ${Object.keys(vars).join(', ')})`);
      return String(vars[k]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => applyVars(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, applyVars(v, vars)]));
  return value;
}

// Built-in variables: run (4 characters unique to this run), date (YYYY-MM-DD), time (HH:MM).
// The storyboard's `vars:` may override them and may use them in their own values.
export function storyboardVars(custom = {}) {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  const builtin = {
    run: Date.now().toString(36).slice(-4).toUpperCase(),
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
  const vars = { ...builtin };
  for (const [k, v] of Object.entries(custom || {})) vars[k] = applyVars(v, vars);
  return vars;
}

// A step carries its target in one of two shapes: `click: {role: ...}` or `type: {target: {...}, value: ...}`
export function targetOf(step, action) {
  const v = step[action];
  if (v && typeof v === 'object' && 'target' in v) return v.target;
  return v;
}

export function jpegSize(buf) {
  for (let i = 2; i < buf.length - 9; i++) {
    if (buf[i] === 0xff && (buf[i + 1] === 0xc0 || buf[i + 1] === 0xc2)) {
      return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]; // [w, h]
    }
  }
  return null;
}

// ---------------------------------------------------------------- runner
// Are the element's center and right side (the type click point) covered by another element?
async function covered(loc) {
  return loc
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      const y = r.top + r.height / 2;
      return [0.5, 0.8].some((fx) => {
        const hit = document.elementFromPoint(r.left + r.width * fx, y);
        if (!hit) return false;
        const own = hit === el || el.contains(hit) || hit.contains(el) || [...(el.labels || [])].some((l) => l.contains(hit));
        return !own;
      });
    })
    .catch(() => false);
}

// A native <select> opens an OS popup that never shows up in the screencast, so the
// video would show the value jumping without the list ever opening. While recording we
// draw a look-alike list inside the page instead (top layer, so it sits above modal
// dialogs), let the cursor travel to the option, then close it and set the real value.
// Returns the list and target-option rects (viewport CSS px), or null if not possible.
async function openFakeSelect(loc, opt) {
  return loc
    .evaluate((el, opt) => {
      if (el.tagName !== 'SELECT' || el.multiple) return null;
      const opts = [...el.options].filter((o) => !o.hidden);
      let idx = -1;
      if (opt && typeof opt === 'object' && typeof opt.index === 'number') idx = opts.indexOf(el.options[opt.index]);
      else {
        const want = typeof opt === 'object' ? opt.label ?? opt.value : String(opt);
        idx = opts.findIndex((o) => o.label.trim() === String(want).trim());
        if (idx < 0) idx = opts.findIndex((o) => o.value === String(want));
      }
      if (idx < 0) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const rowH = Math.max(30, Math.round(parseFloat(cs.fontSize) * 2));
      const visible = Math.min(opts.length, 8);
      const listH = visible * rowH + 8;
      const below = innerHeight - r.bottom - 8;
      const top = below >= listH || below >= r.top ? r.bottom + 4 : Math.max(8, r.top - 4 - listH);
      const bg = cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) ? cs.backgroundColor : '#fff';
      const list = document.createElement('div');
      list.setAttribute('data-walkreel-select', '');
      list.style.cssText = [
        'position:fixed', 'inset:auto', 'margin:0', `left:${r.left}px`, `top:${top}px`, `width:${r.width}px`,
        `max-height:${listH}px`, 'overflow:hidden', 'padding:4px 0', 'box-sizing:border-box',
        `background:${bg}`, `color:${cs.color}`, `font:${cs.font}`, 'border:1px solid rgba(0,0,0,.12)',
        'border-radius:8px', 'box-shadow:0 12px 32px rgba(0,0,0,.18)', 'z-index:2147483647',
      ].join(';');
      opts.forEach((o, i) => {
        const row = document.createElement('div');
        row.textContent = o.label;
        row.style.cssText = `height:${rowH}px;line-height:${rowH}px;padding:0 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default` +
          (o.selected ? ';font-weight:600' : '') + (o.disabled ? ';opacity:.45' : '');
        list.appendChild(row);
      });
      // top layer via the popover API; otherwise inside the dialog (or body)
      if (list.showPopover) {
        list.popover = 'manual';
        document.body.appendChild(list);
        list.showPopover();
      } else (el.closest('dialog') || document.body).appendChild(list);
      // keep the target option inside the visible part of the list
      list.scrollTop = Math.max(0, (idx - visible + 2) * rowH);
      list.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 140, easing: 'ease-out' });
      const lr = list.getBoundingClientRect();
      const tr = list.children[idx].getBoundingClientRect();
      return { index: idx, list: { x: lr.x, y: lr.y, w: lr.width, h: lr.height }, target: { x: tr.x, y: tr.y, w: tr.width, h: tr.height } };
    }, opt)
    .catch(() => null);
}

// Highlight the option under the cursor. Not done with :hover: an open modal <dialog>
// makes everything outside it inert, so hover never fires on the list.
async function highlightFakeOption(page, idx) {
  await page
    .evaluate((idx) => {
      const row = document.querySelector('[data-walkreel-select]')?.children[idx];
      if (row) row.style.background = 'color-mix(in srgb, currentColor 11%, transparent)';
    }, idx)
    .catch(() => {});
}

async function closeFakeSelect(page) {
  await page
    .evaluate(async () => {
      const list = document.querySelector('[data-walkreel-select]');
      if (!list) return;
      await list.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: 'ease-in' }).finished.catch(() => {});
      list.remove();
    })
    .catch(() => {});
}

// Whether the clicked element submits a form, and its visible name (used for the sound decision).
// Note: a <button> defaults to type=submit; without a form (b.form null) it does not count.
async function clickInfo(loc) {
  return loc
    .evaluate((el) => {
      const b = el.closest('button, input[type=submit], input[type=button], a, [role=button]') || el;
      const tag = b.tagName;
      const type = (b.getAttribute('type') || (tag === 'BUTTON' ? 'submit' : '')).toLowerCase();
      const submit = (tag === 'BUTTON' || tag === 'INPUT') && type === 'submit' && !!b.form;
      const name = (b.getAttribute('aria-label') || b.innerText || b.value || '').trim().slice(0, 80);
      return { submit, name };
    })
    .catch(() => ({}));
}

export class Runner {
  constructor(page, style, { fast }) {
    this.page = page;
    this.style = style;
    this.fast = fast;
    this.events = [];
    const vp = style.capture.viewport;
    this.cursor = { x: vp.width / 2, y: vp.height / 2 };
    this.timeout = 10000;
    this.waitTimeout = 15000; // waitFor default; shortened for optional steps
  }

  log(ev) {
    if (!this.fast) this.events.push(ev);
  }

  async box(loc) {
    const b = await loc.boundingBox();
    if (!b) throw new Error('Could not get the element position (it may not be visible).');
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }

  // Brings the element to the center with a smooth scroll if it is not in view.
  async ensureInView(loc) {
    await loc.waitFor({ state: 'visible', timeout: this.timeout });
    const vp = this.page.viewportSize();
    let b = await this.box(loc);
    const inView = b.y >= 0 && b.y + b.h <= vp.height && b.x >= 0 && b.x + b.w <= vp.width;
    // Even when on screen, a sticky header/footer (dialog footer, fixed header) may cover it
    // and the click would land on that bar. Scrolling it to the center fixes both.
    if (inView && !(await covered(loc))) return b;
    const t0 = now();
    if (this.fast) {
      await loc.scrollIntoViewIfNeeded();
    } else {
      await loc.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }));
      let last = null;
      for (let i = 0; i < 40; i++) {
        await sleep(60);
        const cur = await this.box(loc);
        if (last && Math.abs(cur.y - last.y) < 0.5 && Math.abs(cur.x - last.x) < 0.5) break;
        last = cur;
      }
    }
    b = await this.box(loc);
    this.log({ type: 'scroll', t0, t1: now() });
    return b;
  }

  async moveTo(x, y) {
    const from = { ...this.cursor };
    if (this.fast) {
      await this.page.mouse.move(x, y);
      this.cursor = { x, y };
      return;
    }
    const p = this.style.pacing;
    const dist = Math.hypot(x - from.x, y - from.y);
    if (dist < 2) return;
    const dur = clamp(p.cursorMinMs + dist * p.cursorMsPerPx, p.cursorMinMs, p.cursorMaxMs);
    const n = Math.max(8, Math.round(dur / 16));
    const t0 = now();
    for (let k = 1; k <= n; k++) {
      const e = ease(k / n);
      await this.page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      await sleep(t0 * 1000 + (dur * k) / n - Date.now());
    }
    this.cursor = { x, y };
    this.log({ type: 'move', from: [from.x, from.y], to: [x, y], t0, t1: t0 + dur / 1000 });
  }

  // After a click: if the URL changed, wait for the load (compressed in post-production)
  async settle(urlBefore, extraMs) {
    await sleep(this.fast ? 50 : 120);
    if (this.page.url() !== urlBefore) {
      const t0 = now();
      await this.page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      await this.page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      this.log({ type: 'wait', reason: 'navigation', t0, t1: now() });
    }
    if (!this.fast) await sleep(extraMs);
  }

  // kind: 'field' (clicking a field to type/select) | 'action' (button, link, checkbox).
  // The render decides on sound from this: by default only the submitting click makes a sound.
  async clickAt(loc, b, point, kind = 'action') {
    await loc.click({ trial: true, timeout: this.timeout });
    const info = kind === 'action' && !this.fast ? await clickInfo(loc) : {};
    await this.moveTo(point.x, point.y);
    if (!this.fast) await sleep(this.style.pacing.preClickMs);
    this.log({ type: 'click', kind, ...info, x: point.x, y: point.y, box: b, t: now() });
    await this.page.mouse.down();
    await sleep(this.fast ? 10 : 70);
    await this.page.mouse.up();
  }

  async runStep(step, index, { recordFocus }) {
    const action = actionOf(step);
    const p = this.style.pacing;
    const cam = this.style.camera;
    const page = this.page;
    const urlBefore = page.url();
    const tStep = now();
    this.log({ type: 'step', index, action, caption: step.caption ?? null, sound: step.sound ?? null, t: tStep });

    // Zoom decision: step.zoom true/false/target object; otherwise autoZoomActions
    const zoomSpec = step.zoom;
    let wantZoom = zoomSpec === undefined ? cam.autoZoomActions.includes(action) : !!zoomSpec;
    let focusBox = null;
    let focusT0 = null;
    const startFocus = async (b) => {
      if (!recordFocus || !wantZoom || focusT0 !== null) return;
      if (zoomSpec && typeof zoomSpec === 'object') {
        const zl = await locateTarget(page, zoomSpec);
        focusBox = await this.ensureInView(zl);
      } else focusBox = b;
      focusT0 = now();
    };

    switch (action) {
      case 'goto': {
        const url = new URL(step.goto, this.baseUrl).toString();
        const t0 = now();
        await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        this.log({ type: 'wait', reason: 'goto', t0, t1: now() });
        if (!this.fast) await sleep(p.postClickMs);
        break;
      }
      case 'click':
      case 'check':
      case 'hover': {
        const loc = await locateTarget(page, targetOf(step, action));
        const b = await this.ensureInView(loc);
        await startFocus(b);
        const pt = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        if (action === 'hover') {
          await this.moveTo(pt.x, pt.y);
          if (!this.fast) await sleep(p.postClickMs);
        } else {
          await this.clickAt(loc, b, pt);
          await this.settle(urlBefore, p.postClickMs);
        }
        break;
      }
      case 'type': {
        const spec = step.type;
        if (!spec || typeof spec !== 'object' || spec.value === undefined) throw new Error('A `type` step needs {target, value}.');
        const loc = await locateTarget(page, spec.target);
        const b = await this.ensureInView(loc);
        await startFocus(b);
        // Click the right side of the field so the cursor doesn't cover the typed text, but not
        // the last 40px (number spinners and clear/eye icons live there)
        const pt = { x: b.x + Math.max(b.w * 0.5, Math.min(b.w * 0.8, b.w - 40)), y: b.y + b.h / 2 };
        await this.clickAt(loc, b, pt, 'field');
        const inputType = await loc.evaluate((el) => (el.getAttribute('type') || el.tagName).toLowerCase()).catch(() => 'text');
        const value = String(spec.value);
        const t0 = now();
        if (['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(inputType)) {
          await loc.fill(value);
        } else {
          if (spec.clear !== false) {
            const current = await loc.inputValue().catch(() => '');
            if (current) {
              await page.keyboard.press('ControlOrMeta+A');
              await page.keyboard.press('Backspace');
            }
          }
          await page.keyboard.type(value, { delay: this.fast ? 0 : p.typeDelayMs });
        }
        this.log({ type: 'type', box: b, t0, t1: now(), chars: value.length });
        if (spec.enter) {
          await page.keyboard.press('Enter');
          await this.settle(urlBefore, p.postClickMs);
        } else if (!this.fast) await sleep(250);
        break;
      }
      case 'select': {
        const spec = step.select;
        if (!spec || typeof spec !== 'object' || spec.option === undefined) throw new Error('A `select` step needs {target, option}.');
        const loc = await locateTarget(page, spec.target);
        const b = await this.ensureInView(loc);
        await startFocus(b);
        await this.moveTo(b.x + b.w * 0.85, b.y + b.h / 2);
        if (!this.fast) await sleep(p.preClickMs);
        this.log({ type: 'click', kind: 'field', x: this.cursor.x, y: this.cursor.y, box: b, t: now() });
        const opt = spec.option;
        // Show the list opening and the choice being made (see openFakeSelect)
        const fake = this.fast ? null : await openFakeSelect(loc, opt);
        if (fake) {
          if (focusBox === b) {
            // auto zoom: frame the field and the open list together
            const x0 = Math.min(b.x, fake.list.x), y0 = Math.min(b.y, fake.list.y);
            const x1 = Math.max(b.x + b.w, fake.list.x + fake.list.w), y1 = Math.max(b.y + b.h, fake.list.y + fake.list.h);
            focusBox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          }
          await sleep(p.selectOpenMs ?? 260);
          const t = fake.target;
          await this.moveTo(t.x + Math.min(t.w * 0.6, t.w - 24), t.y + t.h / 2);
          await highlightFakeOption(page, fake.index);
          await sleep(p.selectHoverMs ?? 280);
          this.log({ type: 'click', kind: 'field', x: this.cursor.x, y: this.cursor.y, box: t, t: now() });
          await sleep(120);
          await closeFakeSelect(page);
        }
        await loc.selectOption(typeof opt === 'object' ? opt : { label: String(opt) }, { timeout: this.timeout });
        await this.settle(urlBefore, p.postClickMs);
        break;
      }
      case 'press': {
        this.log({ type: 'key', key: step.press, t: now() });
        await page.keyboard.press(step.press);
        await this.settle(urlBefore, p.postClickMs);
        break;
      }
      case 'scroll': {
        const spec = step.scroll;
        const t0 = now();
        if (spec && typeof spec === 'object' && (spec.to || spec.target)) {
          await this.ensureInView(await locateTarget(page, spec.to || spec.target));
        } else {
          const by = typeof spec === 'number' ? spec : (spec?.by ?? 400);
          await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), by);
          if (!this.fast) await sleep(700);
        }
        this.log({ type: 'scroll', t0, t1: now() });
        break;
      }
      case 'wait': {
        if (zoomSpec && typeof zoomSpec === 'object') await startFocus(null);
        if (!this.fast) await sleep(Number(step.wait) || 1000);
        break;
      }
      case 'waitFor': {
        const spec = step.waitFor;
        const t0 = now();
        if (spec.url) await page.waitForURL(new RegExp(spec.url), { timeout: spec.timeout ?? this.waitTimeout });
        else await (await locateTarget(page, spec.target ?? spec)).waitFor({ state: 'visible', timeout: spec.timeout ?? this.waitTimeout });
        this.log({ type: 'wait', reason: 'waitFor', t0, t1: now() });
        if (zoomSpec && typeof zoomSpec === 'object') {
          await startFocus(null);
          if (!this.fast) await sleep(1200);
        }
        break;
      }
    }

    if (!this.fast && step.hold) await sleep(step.hold);
    if (focusT0 !== null && focusBox) this.log({ type: 'focus', box: focusBox, t0: focusT0, t1: now(), step: index });
    if (!this.fast) await sleep(p.stepGapMs);
  }
}


// ---------------------------------------------------------------- style
// Order: style.json -> format preset (landscape | vertical | square) -> storyboard `style:`.
// The format must be chosen at record time: it sets the viewport (and so the page layout).
export function loadStyle(stylePath, overrides = {}, language, format) {
  const base = JSON.parse(fs.readFileSync(stylePath || path.join(SKILL_DIR, 'config', 'style.json'), 'utf8'));
  const fmt = format || base.format || 'landscape';
  const preset = base.formats?.[fmt];
  if (!preset) throw new Error(`Unknown format: ${fmt} (options: ${Object.keys(base.formats || {}).join(', ')})`);
  const style = deepMerge(deepMerge(base, preset), overrides || {});
  style.format = fmt;
  if (language) style.language = language;
  return style;
}

// ---------------------------------------------------------------- project config
// The .demo-video/ folder, created once per project:
//   config.yaml   baseUrl + login steps (+ crawl settings)
//   auth.json     Playwright storageState after login (cache, must stay out of git)
//   app-map.json  discover.mjs output (pages, fields, buttons)
//   app-map.md    the same map, condensed for Claude to read
export const PROJECT_DIRNAME = '.demo-video';

export function findProjectDir(...starts) {
  for (const s of starts.filter(Boolean)) {
    let d = path.resolve(s);
    while (true) {
      const cand = path.join(d, PROJECT_DIRNAME);
      if (fs.existsSync(path.join(cand, 'config.yaml'))) return cand;
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return null;
}

export function loadProject(dir) {
  if (!dir) return null;
  const cfg = YAML.parse(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8')) || {};
  if (!cfg.baseUrl) throw new Error(`baseUrl is missing in ${dir}/config.yaml.`);
  // Keep the session cache and outputs out of git; config and storyboards may be committed.
  // Leave a .gitignore the user wrote alone.
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'auth.json\nout/\n');
  return {
    dir,
    baseUrl: cfg.baseUrl,
    login: cfg.login || [],
    loginCheck: cfg.loginCheck || null, // optional: URL regex that identifies the login page
    language: cfg.language,
    brandColor: cfg.brandColor || null, // overrides the detected app color ('#rrggbb')
    music: typeof cfg.music === 'boolean' ? cfg.music : null, // the user's answer to "background music?"; null = never asked
    displayUrl: cfg.displayUrl || null, // shown in the video's address bar instead of localhost
    hide: cfg.hide || [], // CSS selectors hidden while recording (cookie banner, chat bubble...)
    crawl: cfg.crawl || {},
    authPath: path.join(dir, 'auth.json'),
    mapJson: path.join(dir, 'app-map.json'),
    mapMd: path.join(dir, 'app-map.md'),
  };
}

// ---------------------------------------------------------------- brand color
// The app's main color, read from the page so the video's background, click ring and
// title card match the app instead of a fixed palette. Candidates, by weight:
//   - background of visible buttons / button-like links (by area; the strongest signal)
//   - common CSS custom properties (--primary, --brand, --accent ...)
//   - <meta name="theme-color">
// Grays, near-white and near-black colors are ignored. Returns '#rrggbb' or null.
export async function detectBrandColor(page) {
  return page
    .evaluate(() => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 1;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      // canvas understands every CSS color syntax (rgb, hsl, oklch, color-mix...)
      const toRgb = (c) => {
        if (!c) return null;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = c.trim();
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return d[3] < 200 ? null : [d[0], d[1], d[2]];
      };
      const hsl = ([r, g, b]) => {
        r /= 255; g /= 255; b /= 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
        const s = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
        return { s, l };
      };
      const scores = new Map();
      const vote = (c, w) => {
        const rgb = toRgb(c);
        if (!rgb) return;
        const { s, l } = hsl(rgb);
        if (s < 0.25 || l < 0.18 || l > 0.78) return; // gray, near-black, pastel/near-white
        const hex = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
        scores.set(hex, (scores.get(hex) || 0) + w * s);
      };
      const vw = innerWidth, vh = innerHeight;
      for (const el of document.querySelectorAll('button, a, [role=button], input[type=submit], input[type=button]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 16 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
        vote(getComputedStyle(el).backgroundColor, Math.min(r.width * r.height, 40000));
      }
      const root = getComputedStyle(document.documentElement);
      for (const name of ['--primary', '--color-primary', '--brand', '--color-brand', '--accent', '--color-accent',
        '--primary-color', '--brand-color', '--theme-color', '--primary-500', '--brand-500', '--color-primary-500']) {
        const v = root.getPropertyValue(name);
        // shadcn-style tokens are bare HSL triples: "222 47% 31%"
        if (v) vote(/^\s*[\d.]+\s+[\d.]+%\s+[\d.]+%\s*$/.test(v) ? `hsl(${v})` : v, 30000);
      }
      vote(document.querySelector('meta[name="theme-color"]')?.content, 20000);
      let best = null, bestScore = 0;
      for (const [hex, sc] of scores) if (sc > bestScore) { best = hex; bestScore = sc; }
      return best;
    })
    .catch(() => null);
}

// ---------------------------------------------------------------- server health
// Before recording: is the server up and reasonably fast? Otherwise a hung dev server
// fails mid-recording with a misleading error like "text not found".
export async function checkServer(url, { timeoutMs = 20000, slowMs = 3000 } = {}) {
  if (!/^https?:/.test(url)) return { ok: true, ms: 0 };
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const ms = Date.now() - t0;
    if (res.status >= 500) return { ok: false, ms, reason: `HTTP ${res.status}` };
    return { ok: true, ms, slow: ms > slowMs };
  } catch (e) {
    const ms = Date.now() - t0;
    const reason = e.name === 'TimeoutError' ? `no response within ${(timeoutMs / 1000).toFixed(0)} s` : e.cause?.code || e.message;
    return { ok: false, ms, reason };
  }
}

// Answers "why" when something fails: requests still pending, HTTP errors, console errors.
export function watchPage(page) {
  const inflight = new Map();
  const httpErrors = [];
  const consoleErrors = [];
  const short = (u) => {
    try {
      const x = new URL(u);
      return x.pathname + (x.search.length > 60 ? x.search.slice(0, 60) + '…' : x.search);
    } catch {
      return u;
    }
  };
  const skip = (r) => ['image', 'font', 'media', 'stylesheet'].includes(r.resourceType()) || r.url().startsWith('data:');
  page.on('request', (r) => { if (!skip(r)) inflight.set(r, Date.now()); });
  page.on('requestfinished', (r) => inflight.delete(r));
  page.on('requestfailed', (r) => {
    inflight.delete(r);
    if (!skip(r)) httpErrors.push(`${r.method()} ${short(r.url())} -> ${r.failure()?.errorText || 'failed'}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && !skip(res.request())) httpErrors.push(`${res.request().method()} ${short(res.url())} -> HTTP ${res.status()}`);
  });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().split('\n')[0].slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push(`(uncaught) ${e.message.split('\n')[0].slice(0, 200)}`));
  return {
    report() {
      const now = Date.now();
      const pending = [...inflight.entries()]
        .filter(([, t]) => now - t > 1000)
        .map(([r, t]) => `${r.method()} ${short(r.url())} (${((now - t) / 1000).toFixed(1)} sn)`);
      const parts = [];
      if (pending.length) parts.push(`Requests still waiting for a response (the server may be stuck):\n  ${pending.slice(-8).join('\n  ')}`);
      if (httpErrors.length) parts.push(`Recent HTTP errors:\n  ${httpErrors.slice(-6).join('\n  ')}`);
      if (consoleErrors.length) parts.push(`Recent console errors:\n  ${consoleErrors.slice(-6).join('\n  ')}`);
      return parts.join('\n');
    },
  };
}

// ---------------------------------------------------------------- browser
export async function launch(style, { headed = false, storageState } = {}) {
  const lang = style.i18n?.[style.language] || {};
  const locale = lang.locale || 'en-US';
  const dpr = style.capture.deviceScaleFactor;
  const browser = await chromium.launch({
    headless: !headed,
    // On Linux, date/number field formats follow the env locale (--lang alone isn't enough)
    env: { ...process.env, LANG: `${locale.replace('-', '_')}.UTF-8`, LANGUAGE: locale.split('-')[0] },
    args: [`--force-device-scale-factor=${dpr}`, '--hide-scrollbars', `--lang=${locale}`],
  });
  const ctxOpts = {
    viewport: style.capture.viewport,
    deviceScaleFactor: dpr,
    locale,
    timezoneId: style.capture.timezone || 'Europe/Istanbul',
  };
  if (storageState && fs.existsSync(storageState)) ctxOpts.storageState = storageState;
  const context = await browser.newContext(ctxOpts);
  if (style.capture.hideScrollbars) {
    await context.addInitScript(() => {
      const add = () => {
        const s = document.createElement('style');
        s.textContent = '::-webkit-scrollbar{display:none!important} html{scrollbar-width:none!important}';
        document.documentElement.appendChild(s);
      };
      if (document.documentElement) add();
      else document.addEventListener('DOMContentLoaded', add);
    });
  }
  // Kept out of the video: dev-server badges (the Next.js "N" indicator etc.) and
  // capture.hide selectors. visibility:hidden keeps the layout and doesn't block clicks.
  const hide = [...(style.capture.hide || [])];
  if (style.capture.hideDevOverlays !== false) hide.push('nextjs-portal', '[data-nextjs-toast]', 'vite-error-overlay');
  if (hide.length) {
    const css = `${hide.join(',')}{visibility:hidden!important;pointer-events:none!important}`;
    await context.addInitScript((text) => {
      const add = () => {
        const s = document.createElement('style');
        s.textContent = text;
        document.documentElement.appendChild(s);
      };
      if (document.documentElement) add();
      else document.addEventListener('DOMContentLoaded', add);
    }, css);
  }
  const page = await context.newPage();
  return { browser, context, page };
}

async function looksLikeLogin(page, project) {
  if (project.loginCheck && new RegExp(project.loginCheck, 'i').test(page.url())) return true;
  return page
    .locator('input[type=password]')
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
}

// Does nothing if the cached session is still valid; otherwise runs the login steps
// in fast mode and writes the storageState to .demo-video/auth.json.
// Returns: 'cached' | 'logged-in' | 'no-login'
export async function ensureAuth(page, context, project, style) {
  if (!project || !project.login.length) return 'no-login';
  await page.goto(project.baseUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  if (!(await looksLikeLogin(page, project))) return 'cached';
  const r = new Runner(page, style, { fast: true });
  r.baseUrl = project.baseUrl;
  for (const [i, s] of project.login.entries()) {
    try {
      await r.runStep(s, i, { recordFocus: false });
    } catch (e) {
      throw new Error(`Login step ${i} (${actionOf(s)}) failed: ${e.message.split('\n')[0]}`);
    }
  }
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  if (await looksLikeLogin(page, project)) throw new Error('The login steps ran but we are still on the sign-in page. Check the credentials/steps.');
  await context.storageState({ path: project.authPath });
  return 'logged-in';
}

export async function ariaOf(page, maxLines = 250) {
  let aria = '';
  try {
    aria = await page.locator('body').ariaSnapshot({ timeout: 5000 });
  } catch (e) {
    aria = `(could not take aria snapshot: ${e.message})`;
  }
  const lines = aria.split('\n');
  return lines.slice(0, maxLines).join('\n') + (lines.length > maxLines ? `\n... (${lines.length - maxLines} more lines)` : '');
}
