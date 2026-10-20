#!/usr/bin/env node
// Plays the storyboard in a real browser and records high-resolution frames plus
// the action timeline (timeline.json). Zoom/cursor/effects are NOT done here; all
// of it is applied by render.py from this timeline.
//
// Usage:
//   node scripts/record.mjs <storyboard.yaml> --out <dir> [--format landscape|vertical|square] [--style <style.json>] [--headed]
//   node scripts/record.mjs <storyboard.yaml> --inspect [--upto N] [--out <dir>]
//
// Project config: .demo-video/config.yaml is searched upwards from the storyboard's
// folder (or the working directory). If found, baseUrl comes from there and the login
// is cached in .demo-video/auth.json, so storyboards need no login steps.
//
// setup / teardown: steps kept out of the video. setup runs before recording, teardown
// after it (even if recording failed), both in fast mode; teardown removes the data the
// recording created. A setup/teardown step with `optional: true` is skipped if it fails
// (e.g. "delete the leftover from an earlier run if there is one"). The browser's native
// confirm/alert dialogs are accepted automatically.
//
// vars: "{{name}}" placeholders. Built-ins: {{run}} (4 characters unique to this run),
// {{date}}, {{time}}. Define `vars:` to reuse a value in steps and teardown.
//
// --inspect: runs the first N steps quickly without recording and prints the page's
// accessibility tree (aria snapshot) and a screenshot.

import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import {
  SKILL_DIR, ACTIONS, sleep, now, actionOf, describeTarget, targetOf, jpegSize, Runner,
  loadStyle, findProjectDir, loadProject, launch, ensureAuth, ariaOf, applyVars, storyboardVars,
  checkServer, watchPage, detectBrandColor,
} from './lib.mjs';

function parseArgs(argv) {
  const a = { storyboard: null, out: null, style: path.join(SKILL_DIR, 'config', 'style.json'), headed: false, inspect: false, upto: null, format: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--out') a.out = argv[++i];
    else if (v === '--style') a.style = argv[++i];
    else if (v === '--headed') a.headed = true;
    else if (v === '--format') a.format = argv[++i];
    else if (v === '--inspect') a.inspect = true;
    else if (v === '--upto') a.upto = parseInt(argv[++i], 10);
    else if (!a.storyboard) a.storyboard = v;
    else throw new Error(`Unknown argument: ${v}`);
  }
  if (!a.storyboard) {
    console.error('Usage: node scripts/record.mjs <storyboard.yaml> --out <dir> [--format landscape|vertical|square] [--style style.json] [--inspect --upto N] [--headed]');
    process.exit(1);
  }
  return a;
}

function validateStoryboard(sb, project) {
  const errs = [];
  if (!sb || typeof sb !== 'object') errs.push('Storyboard is empty or not valid YAML.');
  else {
    if (!sb.title) errs.push('`title` eksik.');
    if (!sb.app?.baseUrl && !project) errs.push('`app.baseUrl` is missing and no .demo-video/config.yaml was found.');
    if (!Array.isArray(sb.steps) || sb.steps.length === 0) errs.push('`steps` must not be empty.');
    for (const [name, list] of [['setup', sb.setup || []], ['steps', sb.steps || []], ['teardown', sb.teardown || []]]) {
      list.forEach((s, i) => {
        const acts = Object.keys(s || {}).filter((k) => ACTIONS.includes(k));
        if (acts.length !== 1) errs.push(`${name}[${i}]: needs exactly one action (${ACTIONS.join(', ')}). Found: ${acts.join(', ') || 'none'}`);
      });
    }
  }
  if (errs.length) throw new Error('Storyboard errors:\n - ' + errs.join('\n - '));
}

async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const sbPath = path.resolve(args.storyboard);
  const sbDir = path.dirname(sbPath);
  const raw = YAML.parse(fs.readFileSync(sbPath, 'utf8'));
  const { vars: customVars, ...rest } = raw || {};
  const vars = storyboardVars(customVars);
  const sb = applyVars(rest, vars);

  let project = loadProject(findProjectDir(sbDir, process.cwd()));
  // Don't use the project's login if the storyboard targets another app
  if (project && sb.app?.baseUrl && new URL(sb.app.baseUrl).origin !== new URL(project.baseUrl).origin) project = null;
  validateStoryboard(sb, project);
  const baseUrl = sb.app?.baseUrl || project.baseUrl;

  const style = loadStyle(args.style, sb.style, sb.language || project?.language, args.format || sb.format);
  if (project?.hide?.length) style.capture.hide = [...(style.capture.hide || []), ...project.hide];
  // Music is the user's choice: storyboard `music:` > config `music:` > style default
  const music = typeof sb.music === 'boolean' ? sb.music : project?.music;
  if (typeof music === 'boolean') style.music.enabled = music;
  else if (project) console.log(`Note: \`music:\` is not set in .demo-video/config.yaml; using the default (${style.music.enabled ? 'on' : 'off'}). Ask the user and save their answer.`);
  if (project?.displayUrl && !style.frame.browserBar.displayUrl) style.frame.browserBar.displayUrl = project.displayUrl;
  const outDir = path.resolve(args.out || path.join(sbDir, 'out', path.basename(sbPath).replace(/\.ya?ml$/, '')));
  fs.mkdirSync(outDir, { recursive: true });
  // A leftover timeline would make render turn the previous recording into a video after a failed one
  if (!args.inspect) fs.rmSync(path.join(outDir, 'timeline.json'), { force: true });

  const health = await checkServer(baseUrl);
  if (!health.ok) {
    console.error(`ERROR: ${baseUrl} is not responding: ${health.reason}.\nIs the server running? If the dev server is stuck, restart it (Next.js: stop it, delete the .next folder, start again).`);
    process.exit(3);
  }
  if (health.slow) console.log(`WARNING: the server is slow (${(health.ms / 1000).toFixed(1)} s). The dev server may be compiling or bloated; recording will be slower (waits are compressed in the video).`);

  const storageState = sb.app?.storageState ? path.resolve(sbDir, sb.app.storageState) : project?.authPath;
  const { browser, context, page } = await launch(style, { headed: args.headed, storageState });
  const runner = new Runner(page, style, { fast: true });
  runner.baseUrl = baseUrl;
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const watch = watchPage(page);

  const steps = sb.steps;
  let current = { list: 'setup', index: -1 };

  // setup/teardown: fast mode, not recorded; optional steps are tried with a short timeout.
  // Consecutive optional steps form a chain: once one fails (e.g. nothing to delete),
  // the rest of the chain is skipped without waiting.
  const runQuiet = async (list, name) => {
    let chainBroken = false;
    for (const [i, s] of (list || []).entries()) {
      current = { list: name, index: i };
      if (!s.optional) chainBroken = false;
      else if (chainBroken) continue;
      const { timeout, waitTimeout } = runner;
      if (s.optional) Object.assign(runner, { timeout: 3000, waitTimeout: 3000 });
      try {
        await runner.runStep(s, i, { recordFocus: false });
      } catch (e) {
        if (!s.optional) throw e;
        chainBroken = true;
        console.log(`  ${name}[${i}] skipped (optional; the rest of the chain is skipped too): ${e.message.split('\n')[0]}`);
      } finally {
        Object.assign(runner, { timeout, waitTimeout });
      }
    }
  };
  // Runs once whether or not the recording succeeded; a failure here is a warning, not an error
  let tornDown = false;
  const teardown = async () => {
    if (tornDown || args.inspect || !sb.teardown?.length) return;
    tornDown = true;
    try {
      await runQuiet(sb.teardown, 'teardown');
      console.log('Teardown done.');
    } catch (e) {
      console.error(`WARNING: teardown[${current.index}] failed: ${e.message.split('\n')[0]} (remove the created data by hand)`);
    }
  };

  const dumpPage = async (label) => {
    const shot = path.join(outDir, `${label}.png`);
    await page.screenshot({ path: shot, scale: 'css' }).catch(() => {});
    return { url: page.url(), title: await page.title().catch(() => ''), screenshot: shot, aria: await ariaOf(page) };
  };

  try {
    // 1) Session: project login (cached) + the storyboard's own setup. Not in the video.
    current = { list: 'login', index: -1 };
    const auth = await ensureAuth(page, context, project, style);
    if (auth !== 'no-login') console.log(`Session: ${auth === 'cached' ? 'using cache' : 'signed in, cache updated'}`);
    await runQuiet(sb.setup, 'setup');

    // ---- INSPECT mode
    if (args.inspect) {
      const upto = args.upto ?? 0;
      for (let i = 0; i < Math.min(upto, steps.length); i++) {
        current = { list: 'steps', index: i };
        await runner.runStep(steps[i], i, { recordFocus: false });
      }
      if (page.url() === 'about:blank') await page.goto(baseUrl, { waitUntil: 'load' });
      const d = await dumpPage(`inspect-${upto}`);
      console.log(`URL: ${d.url}\nTitle: ${d.title}\nScreenshot: ${d.screenshot}\n\n--- aria snapshot ---\n${d.aria}`);
      await browser.close();
      return;
    }

    // 2) If the first step is a goto, load it before recording so the video starts on a loaded page
    let startIdx = 0;
    let firstCaption = null;
    if (actionOf(steps[0]) === 'goto') {
      current = { list: 'steps', index: 0 };
      await runner.runStep(steps[0], 0, { recordFocus: false });
      firstCaption = steps[0].caption ?? null;
      startIdx = 1;
    } else if (page.url() === 'about:blank') {
      await page.goto(baseUrl, { waitUntil: 'load' });
    }

    // Brand color: config/storyboard override, else read from the page about to be recorded
    const brandOverride = sb.brandColor || project?.brandColor;
    const brand = brandOverride
      ? { color: brandOverride, source: 'config' }
      : { color: await detectBrandColor(page), source: 'page' };
    console.log(brand.color ? `Brand color: ${brand.color} (${brand.source === 'config' ? 'from config' : 'detected on the page'})` : 'Brand color: none found, using the neutral palette');

    // 3) Recording
    const framesDir = path.join(outDir, 'frames');
    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.mkdirSync(framesDir, { recursive: true });
    const frames = [];
    const pending = [];
    let frameSize = null;
    const cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      const buf = Buffer.from(data, 'base64');
      if (!frameSize) frameSize = jpegSize(buf);
      const f = `f_${String(frames.length).padStart(6, '0')}.jpg`;
      frames.push({ f, t: metadata.timestamp });
      pending.push(fs.promises.writeFile(path.join(framesDir, f), buf));
    });

    const rec = new Runner(page, style, { fast: false });
    rec.baseUrl = baseUrl;
    rec.cursor = { ...runner.cursor };
    page.on('framenavigated', (fr) => {
      if (fr === page.mainFrame()) rec.log({ type: 'url', url: fr.url(), t: now() });
    });

    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: style.capture.jpegQuality, everyNthFrame: 1 });
    const tStart = now();
    rec.log({ type: 'url', url: page.url(), t: tStart });
    if (startIdx === 1) rec.log({ type: 'step', index: 0, action: 'goto', caption: firstCaption, t: tStart });
    rec.log({ type: 'move', from: [rec.cursor.x, rec.cursor.y], to: [rec.cursor.x, rec.cursor.y], t0: tStart, t1: tStart });
    await sleep(style.pacing.startHoldMs);

    for (let i = startIdx; i < steps.length; i++) {
      current = { list: 'steps', index: i };
      await rec.runStep(steps[i], i, { recordFocus: true });
    }
    await sleep(style.pacing.endHoldMs);
    const tEnd = now();
    await cdp.send('Page.stopScreencast').catch(() => {});
    await sleep(150);
    await Promise.all(pending);

    frames.sort((a, b) => a.t - b.t);
    if (frames.length === 0) throw new Error('No frames were captured.');

    const timeline = {
      version: 1,
      title: sb.title,
      subtitle: sb.subtitle ?? null,
      language: style.language,
      baseUrl,
      brand,
      viewport: style.capture.viewport,
      dpr: style.capture.deviceScaleFactor,
      frameSize,
      tStart,
      tEnd,
      frames,
      events: rec.events.sort((a, b) => (a.t ?? a.t0) - (b.t ?? b.t0)),
      style,
    };
    fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 1));
    console.log(`Recording done: ${frames.length} frames, ${(tEnd - tStart).toFixed(1)} s raw, ${((Date.now() - t0) / 1000).toFixed(1)} s total`);
    console.log(`Output: ${outDir}/timeline.json`);
    await teardown();
    await browser.close();
  } catch (err) {
    const list = { setup: sb.setup, steps, teardown: sb.teardown }[current.list] || [];
    const step = list[current.index];
    console.error(`\nERROR: ${current.list}${current.index >= 0 ? `[${current.index}]` : ''} failed.`);
    if (step) {
      const a = actionOf(step);
      console.error(`Step: ${a} ${a === 'goto' || a === 'press' || a === 'wait' ? step[a] : describeTarget(targetOf(step, a))}`);
    }
    console.error(`Reason: ${err.message.split('\n')[0]}`);
    const diag = watch.report();
    if (diag) console.error(`\n${diag}`);
    if (project) console.error(`Hint: if the UI changed, refresh the map: node scripts/discover.mjs --refresh`);
    const d = await dumpPage('failure').catch(() => null);
    if (d) console.error(`\nPage: ${d.url}\nScreenshot: ${d.screenshot}\n\n--- aria snapshot (pick targets from here) ---\n${d.aria}`);
    if (current.list === 'steps') await teardown();
    await browser.close();
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
