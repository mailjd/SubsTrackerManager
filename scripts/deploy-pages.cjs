#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();
const CONFIG = path.join(ROOT, 'wrangler.toml');
const content = fs.readFileSync(CONFIG, 'utf8');
const match = content.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
if (!match) throw new Error('wrangler.toml 缺少 Pages project name');
const projectName = match[1];
const branch = process.env.CF_PAGES_BRANCH || process.env.GITHUB_REF_NAME || 'main';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

execFileSync(npx, [
  'wrangler', 'pages', 'deploy', 'public',
  '--project-name', projectName,
  '--branch', branch,
  '--config', 'wrangler.toml'
], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env
});
