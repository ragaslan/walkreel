#!/usr/bin/env node
// Install check: tries everything the skill needs in one go and prints the install
// command for whatever is missing. Run it once, on first use.
//
// Usage: node scripts/doctor.mjs
// Exit code: 0 = ready, 1 = something is missing

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, fix) => results.push({ name, ok, fix });

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

// Node
const major = Number(process.versions.node.split('.')[0]);
check(`Node.js >= 18 (found ${process.versions.node})`, major >= 18, 'Install Node.js 18 or newer: https://nodejs.org');

// npm packages
const hasPkg = (p) => fs.existsSync(path.join(SKILL_DIR, 'node_modules', p, 'package.json'));
const pkgsOk = hasPkg('playwright') && hasPkg('yaml');
check('npm packages (playwright, yaml)', pkgsOk, `cd "${SKILL_DIR}" && npm install`);

// Chromium
let chromiumOk = false;
if (pkgsOk) {
  try {
    const { chromium } = await import(path.join(SKILL_DIR, 'node_modules', 'playwright', 'index.mjs'));
    chromiumOk = fs.existsSync(chromium.executablePath());
  } catch {
    chromiumOk = false;
  }
}
check('Playwright Chromium', chromiumOk, `cd "${SKILL_DIR}" && npx playwright install chromium`);

// Python + modules
const py = run('python3', ['-c', 'import sys; print(sys.version.split()[0])']);
check(`Python 3${py ? ` (found ${py.trim()})` : ''}`, !!py, 'Install Python 3.9+: https://www.python.org');
if (py) {
  const missing = [['cv2', 'opencv-python-headless'], ['numpy', 'numpy'], ['PIL', 'pillow']].filter(
    ([mod]) => run('python3', ['-c', `import ${mod}`]) === null,
  );
  check('Python modules (opencv, numpy, pillow)', missing.length === 0, `python3 -m pip install ${missing.map(([, p]) => p).join(' ')}`);
}

// ffmpeg + codecs
const ff = run('ffmpeg', ['-hide_banner', '-encoders']);
check('ffmpeg', !!ff, 'Install ffmpeg (macOS: brew install ffmpeg · Ubuntu: sudo apt install ffmpeg · Windows: winget install ffmpeg)');
if (ff) {
  check('ffmpeg libx264 + aac codecs', /libx264/.test(ff) && /\baac\b/.test(ff), 'Install an ffmpeg build with libx264 (all official packages have it)');
}

// The skill's own files
check('Fonts (assets/fonts)', fs.existsSync(path.join(SKILL_DIR, 'assets', 'fonts', 'Inter-Bold.otf')), 'The skill was copied incompletely; reinstall it');
check('Music (assets/music/theme.m4a)', fs.existsSync(path.join(SKILL_DIR, 'assets', 'music', 'theme.m4a')), `python3 "${path.join(SKILL_DIR, 'scripts', 'make_music.py')}"`);

const bad = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '  ok    ' : ' MISSING'}  ${r.name}`);
if (bad.length) {
  console.log('\nTo fix:');
  for (const r of bad) console.log(`  - ${r.name}: ${r.fix}`);
  process.exit(1);
}
console.log('\nReady.');
