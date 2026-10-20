#!/usr/bin/env node
// walkreel CLI: installs the skill where Claude looks for skills, and runs the checks.
//
//   npx walkreel install             -> ~/.claude/skills/walkreel (all projects)
//   npx walkreel install --project   -> ./.claude/skills/walkreel (this project only)
//   npx walkreel install --dir <path>
//   npx walkreel doctor              -> checks Node, Chromium, Python modules, ffmpeg
//
// install copies the skill, installs its npm dependencies and Chromium there, then runs
// the doctor. Python (opencv, numpy, pillow) and ffmpeg can't come from npm; the doctor
// prints the exact command for them.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
// What makes up the installed skill (node_modules is installed fresh in the target)
const PARTS = ['SKILL.md', 'README.md', 'LICENSE', 'package.json', 'package-lock.json', 'config', 'scripts', 'assets', 'examples', 'bin'];

function help() {
  console.log(`walkreel ${pkg.version} — polished demo videos of web app features, as a Claude skill

Usage:
  npx walkreel install [--project | --dir <path>] [--force]
  npx walkreel doctor

install    copy the skill to ~/.claude/skills/walkreel (or ./.claude/skills/walkreel with
           --project), install its dependencies and Chromium, then check the rest
doctor     check that everything the skill needs is installed`);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\n"${cmd} ${args.join(' ')}" failed (exit ${r.status}).`);
    process.exit(r.status || 1);
  }
}

function install(argv) {
  let target = path.join(os.homedir(), '.claude', 'skills', 'walkreel');
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') target = path.resolve('.claude', 'skills', 'walkreel');
    else if (argv[i] === '--dir') target = path.resolve(argv[++i]);
    else if (argv[i] === '--force') force = true;
    else {
      console.error(`Unknown option: ${argv[i]}`);
      process.exit(1);
    }
  }
  if (path.resolve(target) === PKG_DIR) {
    console.log(`Already running from ${target}; installing dependencies only.`);
  } else {
    if (fs.existsSync(path.join(target, '.git')) && !force) {
      console.error(`${target} is a git checkout (a development copy?). Update it with git, or pass --force to overwrite.`);
      process.exit(1);
    }
    fs.mkdirSync(target, { recursive: true });
    for (const part of PARTS) {
      const src = path.join(PKG_DIR, part);
      if (!fs.existsSync(src)) continue;
      fs.rmSync(path.join(target, part), { recursive: true, force: true });
      fs.cpSync(src, path.join(target, part), { recursive: true });
    }
    console.log(`Copied walkreel ${pkg.version} to ${target}`);
  }
  console.log('\nInstalling dependencies…');
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], target);
  console.log('\nInstalling Chromium for Playwright (skipped if already present)…');
  run('npx', ['--no-install', 'playwright', 'install', 'chromium'], target);
  console.log('');
  const r = spawnSync(process.execPath, [path.join(target, 'scripts', 'doctor.mjs')], { stdio: 'inherit' });
  console.log(r.status === 0
    ? `\nDone. Ask Claude for a video, e.g. "make a video showing how to create a project in our app".`
    : `\nThe skill is installed; finish the steps above, then run: npx walkreel doctor`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'install') install(rest);
else if (cmd === 'doctor') {
  // check the installed copy (the npx cache keeps dependencies elsewhere)
  const installed = path.join(os.homedir(), '.claude', 'skills', 'walkreel');
  const dir = fs.existsSync(path.join(installed, 'scripts', 'doctor.mjs')) ? installed : PKG_DIR;
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'doctor.mjs')], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
} else if (cmd === '--version' || cmd === '-v') console.log(pkg.version);
else help();
