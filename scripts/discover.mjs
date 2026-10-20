#!/usr/bin/env node
// Maps the app in one go and caches the result under .demo-video/.
// Claude writes the storyboard from this map in a single pass; later videos of the
// same app skip discovery entirely.
//
// What it does:
//   1. Signs in once (config.yaml -> login) and stores the session in auth.json.
//   2. Crawls same-origin links (BFS, limited by page count and time).
//   3. On every page, extracts headings, links, buttons, form fields (with select
//      options) and table columns using Playwright's aria names. Those names are used
//      as {role, name} / {label} targets in storyboards as they are.
//   4. Clicks "New / Add / Create"-like buttons and records the modal or page they
//      open. It NEVER clicks Save / Delete / Send-like buttons and never submits forms.
//
// Usage:
//   node scripts/discover.mjs                     # uses the cache if present (no browser)
//   node scripts/discover.mjs --refresh           # rebuilds the map from scratch
//   node scripts/discover.mjs --only "/contacts/new" [--only ...]   # refresh only these pages
//   node scripts/discover.mjs --project <dir>     # start looking for .demo-video/ here
//
// Output: .demo-video/app-map.md (what Claude reads), .demo-video/app-map.json (raw data)

import fs from 'node:fs';
import path from 'node:path';
import { loadStyle, findProjectDir, loadProject, launch, ensureAuth, checkServer } from './lib.mjs';

const CREATE_RE = /(^|\s|\+|＋)(yeni|ekle|oluştur|olustur|new|add|create)(\s|$)/i;
const DANGER_RE = /(kaydet|güncelle|sil|kaldır|delete|remove|save|update|gönder|send|submit|onayla|confirm|öde|pay|çıkış|cikis|logout|sign ?out|log ?out|iptal et|archive|arşivle)/i;
const LOGOUT_RE = /(logout|log-out|signout|sign-out|cikis|çıkış|oturumu-kapat)/i;
const SKIP_EXT_RE = /\.(pdf|zip|csv|xlsx?|docx?|png|jpe?g|gif|svg|mp4)$/i;
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'spinbutton', 'slider', 'switch']);

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const a = { refresh: false, only: [], project: null, maxPages: null, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--refresh') a.refresh = true;
    else if (v === '--only') a.only.push(argv[++i]);
    else if (v === '--project') a.project = argv[++i];
    else if (v === '--max-pages') a.maxPages = parseInt(argv[++i], 10);
    else if (v === '--headed') a.headed = true;
    else throw new Error(`Unknown argument: ${v}`);
  }
  return a;
}

// ---------------------------------------------------------------- aria snapshot parsing
// Playwright aria snapshot lines:  - role "name" [attr=..]: text   /   - /url: "..."
const LINE_RE = /^(\s*)- ([a-zA-Z]+)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]]*)\])?(?::\s*(.*))?$/;
const PROP_RE = /^(\s*)- \/([a-zA-Z]+):\s*(.*)$/;

function unq(s) {
  if (s == null) return s;
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  return s;
}

function parseAria(text) {
  const root = { role: 'root', children: [], depth: -1 };
  const stack = [root];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^\s*/)[0].length;
    while (stack.length > 1 && stack[stack.length - 1].depth >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    const pm = raw.match(PROP_RE);
    if (pm) {
      parent.props = parent.props || {};
      parent.props[pm[2]] = unq(pm[3]);
      continue;
    }
    const m = raw.match(LINE_RE);
    if (!m) continue;
    const [, , role, name, attrs, rest] = m;
    const node = { role, name: name != null ? unq(`"${name}"`) : null, attrs: attrs || null, depth: indent, children: [] };
    if (role === 'text' && rest) node.name = unq(rest);
    else if (rest && rest.trim() && !node.name) node.text = unq(rest);
    parent.children.push(node);
    stack.push(node);
  }
  return root;
}

function walk(node, fn, ctx = []) {
  for (const c of node.children || []) {
    fn(c, ctx);
    walk(c, fn, [...ctx, c.role]);
  }
}

// The summary a storyboard needs, taken from an aria tree
function summarize(tree, { skipDialogs = true } = {}) {
  const out = { headings: [], links: [], buttons: [], fields: [], columns: [], dialogs: [] };
  const seen = new Set();
  walk(tree, (n, ctx) => {
    const inDialog = ctx.includes('dialog') || ctx.includes('alertdialog');
    if (skipDialogs && inDialog) return;
    const global = ctx.some((r) => ['navigation', 'complementary', 'banner', 'contentinfo'].includes(r));
    if (n.role === 'dialog' || n.role === 'alertdialog') {
      if (skipDialogs) out.dialogs.push({ name: n.name, ...summarize(n, { skipDialogs: false }) });
      return;
    }
    if (n.role === 'heading' && n.name) {
      const lvl = parseInt((n.attrs || '').match(/level=(\d)/)?.[1] || '2', 10);
      if (lvl <= 3) out.headings.push(n.name);
    } else if (n.role === 'link' && n.name) {
      const k = `l|${n.name}|${n.props?.url}`;
      if (!seen.has(k)) { seen.add(k); out.links.push({ name: n.name, url: n.props?.url ?? null, global }); }
    } else if (n.role === 'button' && n.name) {
      const k = `b|${n.name}`;
      if (!seen.has(k)) { seen.add(k); out.buttons.push({ name: n.name, global }); }
    } else if (FIELD_ROLES.has(n.role)) {
      const f = { role: n.role, name: n.name || null };
      if (n.props?.placeholder) f.placeholder = n.props.placeholder;
      if (n.attrs) f.state = n.attrs;
      if (n.role === 'combobox' || n.role === 'listbox') {
        const opts = (n.children || []).filter((c) => c.role === 'option').map((c) => c.name);
        if (opts.length) f.options = opts;
      }
      out.fields.push(f);
    } else if (n.role === 'columnheader' && n.name) {
      out.columns.push(n.name);
    }
  });
  return out;
}

// ---------------------------------------------------------------- URL helpers
function isHashRoute(u) {
  return /^#!?\//.test(u.hash);
}

function normUrl(href, base) {
  const u = new URL(href, base);
  if (!isHashRoute(u)) u.hash = '';
  u.search = '';
  return u.toString().replace(/\/(#|$)/, (m, g) => (g === '#' ? '/#' : '/'));
}

function patternOf(key) {
  return key.replace(/\/(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,})(?=\/|$|#|\?)/gi, '/:id');
}

function shortPath(key, origin) {
  return key.startsWith(origin) ? key.slice(origin.length) || '/' : key;
}

// ---------------------------------------------------------------- page capture
async function settle(page, ms = 500) {
  await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

async function snapshot(page, locator) {
  try {
    return await (locator || page.locator('body')).ariaSnapshot({ timeout: 5000 });
  } catch {
    return '';
  }
}

// add the real input type of textboxes (date, email, tel...)
async function enrichFields(page, fields) {
  for (const f of fields) {
    if (f.role !== 'textbox' || !f.name) continue;
    try {
      const t = await page.getByRole('textbox', { name: f.name, exact: true }).first().getAttribute('type', { timeout: 400 });
      if (t && t !== 'text') f.type = t;
    } catch {}
  }
  // fields like date/time may not show up with the textbox role; fill them in from the DOM
  const extra = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('input[type=date],input[type=time],input[type=datetime-local],input[type=month]')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const lab = (el.labels && el.labels[0]?.innerText) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '';
      out.push({ name: lab.trim(), type: el.type });
    }
    return out;
  }).catch(() => []);
  for (const e of extra) {
    const hit = fields.find((f) => f.name && e.name && f.name.trim() === e.name);
    if (hit) hit.type = e.type;
    else if (e.name) fields.push({ role: 'textbox', name: e.name, type: e.type });
  }
}

async function capturePage(page) {
  const aria = await snapshot(page);
  const sum = summarize(parseAria(aria));
  await enrichFields(page, sum.fields);
  for (const d of sum.dialogs) await enrichFields(page, d.fields);
  return { title: await page.title().catch(() => ''), ...sum, aria: aria.split('\n').slice(0, 200).join('\n') };
}

// Try "New / Add" buttons: do they open a modal, change the page, or reveal a form?
async function probeButtons(page, url, info, origin, budgetOk) {
  const results = [];
  const candidates = info.buttons.filter((b) => !b.global && CREATE_RE.test(b.name) && !DANGER_RE.test(b.name)).slice(0, 4);
  const beforeFields = new Set(info.fields.map((f) => `${f.role}|${f.name}`));
  for (const b of candidates) {
    if (!budgetOk()) break;
    try {
      if (normUrl(page.url(), page.url()) !== url) {
        await page.goto(url, { waitUntil: 'load', timeout: 20000 });
        await settle(page, 300);
      }
      await page.getByRole('button', { name: b.name, exact: true }).first().click({ timeout: 3000 });
      await settle(page, 600);
      const after = normUrl(page.url(), page.url());
      if (after !== url) {
        results.push({ button: b.name, opens: 'page', url: after });
        continue;
      }
      const dlg = page.locator('[role=dialog]:visible, [role=alertdialog]:visible, dialog[open]').first();
      if (await dlg.isVisible({ timeout: 300 }).catch(() => false)) {
        const sum = summarize(parseAria(await snapshot(page, dlg)), { skipDialogs: false });
        await enrichFields(page, sum.fields);
        const name = (await dlg.getAttribute('aria-label').catch(() => null)) || sum.headings[0] || null;
        results.push({ button: b.name, opens: 'dialog', name, ...sum });
      } else {
        const sum = summarize(parseAria(await snapshot(page)));
        const newFields = sum.fields.filter((f) => !beforeFields.has(`${f.role}|${f.name}`));
        if (newFields.length) {
          await enrichFields(page, newFields);
          results.push({ button: b.name, opens: 'inline', fields: newFields, buttons: sum.buttons.filter((x) => !info.buttons.some((y) => y.name === x.name)) });
        } else if (sum.dialogs.length) {
          results.push({ button: b.name, opens: 'dialog', ...sum.dialogs[0] });
        }
      }
      await page.keyboard.press('Escape').catch(() => {});
    } catch (e) {
      results.push({ button: b.name, opens: 'error', error: e.message.split('\n')[0] });
    }
  }
  return results;
}

// ---------------------------------------------------------------- markdown
function fmtField(f) {
  let s = `${f.role} "${f.name ?? ''}"`;
  const meta = [];
  if (f.type) meta.push(f.type);
  if (f.placeholder && f.placeholder !== f.name) meta.push(`placeholder: ${f.placeholder}`);
  if (f.state) meta.push(f.state);
  if (meta.length) s += ` (${meta.join(', ')})`;
  if (f.options) s += ` options: ${f.options.slice(0, 12).join(' | ')}${f.options.length > 12 ? ` | … (+${f.options.length - 12})` : ''}`;
  return s;
}

function fmtBlock(lines, title, items, fmt, indent = '') {
  if (!items || !items.length) return;
  if (items.length <= 3 && items.every((x) => fmt(x).length < 50)) lines.push(`${indent}${title}: ${items.map(fmt).join(', ')}`);
  else {
    lines.push(`${indent}${title}:`);
    for (const x of items) lines.push(`${indent}  - ${fmt(x)}`);
  }
}

function routeTo(map, key) {
  const parts = [];
  let cur = map.pages[key];
  const guard = new Set();
  while (cur && cur.via && !guard.has(cur.key)) {
    guard.add(cur.key);
    parts.unshift(`${cur.via.kind} "${cur.via.name}"`);
    cur = map.pages[cur.via.from];
  }
  const start = cur ? shortPath(cur.key, map.origin) : '?';
  return parts.length ? `${start} → ${parts.join(' → ')}` : `directly (${start})`;
}

function toMarkdown(map) {
  const L = [];
  const pages = Object.values(map.pages).sort((a, b) => a.order - b.order);
  L.push(`# App map`);
  L.push(`${map.baseUrl} · ${pages.length} pages · ${new Date(map.generatedAt).toLocaleString('en-US')}`);
  L.push(`Login: ${map.login}. Target names are Playwright aria names; use them verbatim in storyboards: \`{ role: button, name: "Save" }\`, and for fields \`{ label: "Full name" }\`.`);
  L.push('');
  if (map.globalLinks.length) {
    L.push(`## Global menu (on every page)`);
    L.push(map.globalLinks.map((l) => `link "${l.name}" → ${l.url}`).join(' · '));
    L.push('');
  }
  const gl = new Set(map.globalLinks.map((l) => l.name));
  for (const p of pages) {
    const title = p.headings[0] || p.title || shortPath(p.key, map.origin);
    L.push(`## ${title}  \`${shortPath(p.key, map.origin)}\``);
    if (p.error) { L.push(`(failed to load: ${p.error})`, ''); continue; }
    L.push(`How to reach: ${routeTo(map, p.key)}`);
    if (p.headings.length > 1) L.push(`Headings: ${p.headings.join(' · ')}`);
    const links = p.links.filter((l) => !gl.has(l.name));
    fmtBlock(L, 'Links', links.slice(0, 20), (l) => `link "${l.name}"${l.url ? ` → ${l.url}` : ''}`);
    fmtBlock(L, 'Buttons', p.buttons.filter((b) => !b.global).slice(0, 20), (b) => `button "${b.name}"`);
    fmtBlock(L, 'Fields', p.fields, fmtField);
    if (p.columns.length) L.push(`Table columns: ${p.columns.join(' | ')}`);
    for (const d of p.dialogs) {
      L.push(`Open dialog "${d.name ?? ''}":`);
      fmtBlock(L, 'Fields', d.fields, fmtField, '  ');
      fmtBlock(L, 'Buttons', d.buttons, (b) => `button "${b.name}"`, '  ');
    }
    for (const r of p.probes || []) {
      if (r.opens === 'page') L.push(`button "${r.button}" → page \`${shortPath(r.url, map.origin)}\``);
      else if (r.opens === 'dialog') {
        L.push(`button "${r.button}" → dialog "${r.name ?? ''}":`);
        fmtBlock(L, 'Fields', r.fields, fmtField, '  ');
        fmtBlock(L, 'Buttons', r.buttons, (b) => `button "${b.name}"`, '  ');
      } else if (r.opens === 'inline') {
        L.push(`button "${r.button}" → reveals a form on the page:`);
        fmtBlock(L, 'Fields', r.fields, fmtField, '  ');
        fmtBlock(L, 'Buttons', r.buttons, (b) => `button "${b.name}"`, '  ');
      }
    }
    L.push('');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- main
async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const dir = findProjectDir(args.project || process.cwd());
  if (!dir) {
    console.error(`.demo-video/config.yaml not found. Create this file in the project root:

  # .demo-video/config.yaml
  baseUrl: http://localhost:3000
  language: en
  login:                      # optional; test/demo accounts only
    - goto: /login
    - type: { target: { label: Email }, value: demo@example.test }
    - type: { target: { label: Password }, value: demo1234 }
    - click: { role: button, name: Sign in }
  crawl:                      # optional
    maxPages: 25
    start: [/]                # extra starting paths
    exclude: [/admin/logs]    # URLs containing these are not visited
`);
    process.exit(1);
  }
  const project = loadProject(dir);

  // Cache
  let existing = null;
  if (fs.existsSync(project.mapJson)) {
    existing = JSON.parse(fs.readFileSync(project.mapJson, 'utf8'));
    if (existing.baseUrl !== project.baseUrl) existing = null;
  }
  if (existing && !args.refresh && !args.only.length) {
    const ageH = (Date.now() - new Date(existing.generatedAt).getTime()) / 3.6e6;
    console.log(`Using cache: ${Object.keys(existing.pages).length} pages, ${ageH < 1 ? `${Math.round(ageH * 60)} min` : `${ageH.toFixed(1)} h`} old.`);
    console.log(`Map: ${project.mapMd}`);
    console.log('If the UI changed: --refresh (everything) or --only <path> (one page)');
    return;
  }

  const health = await checkServer(project.baseUrl);
  if (!health.ok) {
    console.error(`ERROR: ${project.baseUrl} is not responding: ${health.reason}. Is the server running?`);
    process.exit(3);
  }
  const style = loadStyle(null, { capture: { deviceScaleFactor: 1, hide: project.hide } }, project.language);
  const { browser, context, page } = await launch(style, { headed: args.headed, storageState: project.authPath });
  const origin = new URL(project.baseUrl).origin;
  const maxPages = args.maxPages ?? project.crawl.maxPages ?? 25;
  const budgetMs = (project.crawl.timeBudgetSec ?? 120) * 1000;
  const budgetOk = () => Date.now() - t0 < budgetMs;
  const exclude = (project.crawl.exclude || []).map((s) => s.toLowerCase());

  const map = existing && args.only.length
    ? existing
    : { version: 1, baseUrl: project.baseUrl, origin, generatedAt: null, login: 'none', pages: {}, globalLinks: [] };
  let order = Object.keys(map.pages).length;

  try {
    const auth = await ensureAuth(page, context, project, style);
    map.login = auth === 'no-login' ? 'none' : 'yes (session cached in .demo-video/auth.json)';
    if (page.url() === 'about:blank') await page.goto(project.baseUrl, { waitUntil: 'load' });
    await settle(page, 200);

    const queue = [];
    const visited = new Set();
    const patterns = new Map();
    if (args.only.length) {
      for (const p of args.only) queue.push({ url: normUrl(p, project.baseUrl), via: map.pages[normUrl(p, project.baseUrl)]?.via ?? null });
    } else {
      queue.push({ url: normUrl(page.url(), page.url()), via: null });
      for (const s of project.crawl.start || []) queue.push({ url: normUrl(s, project.baseUrl), via: null });
    }

    let count = 0;
    while (queue.length && count < maxPages && budgetOk()) {
      const { url, via } = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      try {
        if (normUrl(page.url(), page.url()) !== url) await page.goto(url, { waitUntil: 'load', timeout: 20000 });
        await settle(page, 400);
      } catch (e) {
        map.pages[url] = { key: url, via, order: order++, error: e.message.split('\n')[0], headings: [], links: [], buttons: [], fields: [], columns: [], dialogs: [] };
        continue;
      }
      const key = normUrl(page.url(), page.url());
      if (key !== url && visited.has(key) && !args.only.length) continue; // a redirect to a page we already have
      visited.add(key);
      const info = await capturePage(page);
      info.probes = budgetOk() ? await probeButtons(page, key, info, origin, budgetOk) : [];
      const prev = map.pages[key];
      map.pages[key] = { key, via: via ?? prev?.via ?? null, order: prev?.order ?? order++, ...info };
      count++;
      process.stdout.write(`  ✓ ${shortPath(key, origin)}  (${info.fields.length} fields, ${info.buttons.length} buttons)\n`);

      if (args.only.length) continue;
      const next = [
        ...info.links.map((l) => ({ href: l.url, kind: 'link', name: l.name })),
        ...info.probes.filter((r) => r.opens === 'page').map((r) => ({ href: r.url, kind: 'button', name: r.button })),
      ];
      for (const n of next) {
        if (!n.href || /^(mailto|tel|javascript):/i.test(n.href)) continue;
        let abs;
        try { abs = normUrl(n.href, key); } catch { continue; }
        if (!abs.startsWith(origin) || SKIP_EXT_RE.test(abs) || LOGOUT_RE.test(abs) || LOGOUT_RE.test(n.name)) continue;
        if (exclude.some((x) => abs.toLowerCase().includes(x))) continue;
        if (visited.has(abs) || queue.some((q) => q.url === abs)) continue;
        const pat = patternOf(abs);
        if (pat !== abs) {
          const c = patterns.get(pat) || 0;
          if (c >= 1) continue; // one detail page per URL template is enough
          patterns.set(pat, c + 1);
        }
        queue.push({ url: abs, via: { from: key, kind: n.kind, name: n.name } });
      }
    }
    if (queue.length && !args.only.length) console.log(`  … ${queue.length} pages not visited because of the limits (--max-pages / crawl.timeBudgetSec)`);
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    await browser.close();
    process.exit(2);
  }
  await browser.close();

  // Links repeated on every page -> global menu
  const pages = Object.values(map.pages).filter((p) => !p.error);
  const freq = new Map();
  for (const p of pages) for (const l of new Map(p.links.map((l) => [l.name, l])).values()) {
    const k = l.name;
    freq.set(k, { l, n: (freq.get(k)?.n || 0) + 1, global: (freq.get(k)?.global || false) || l.global });
  }
  map.globalLinks = [...freq.values()]
    .filter((x) => (pages.length >= 3 && x.n >= Math.ceil(pages.length * 0.6)) || (x.global && x.n >= 2))
    .map((x) => ({ name: x.l.name, url: x.l.url }));
  map.generatedAt = new Date().toISOString();

  fs.writeFileSync(project.mapJson, JSON.stringify(map, null, 1));
  fs.writeFileSync(project.mapMd, toMarkdown(map));
  console.log(`\nMap ready: ${pages.length} pages, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`Read: ${project.mapMd}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
