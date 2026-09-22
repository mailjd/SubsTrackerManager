#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();
const PAGE_CONFIG = path.join(ROOT, 'wrangler.toml');
const CRON_CONFIG = path.join(ROOT, 'wrangler.pages-cron.toml');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(args, options = {}) {
  return execFileSync(npx, ['wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    input: options.input,
    env: process.env
  });
}

function readName(configPath) {
  const text = fs.readFileSync(configPath, 'utf8');
  const match = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  if (!match) throw new Error(`${path.basename(configPath)} 缺少 name`);
  return match[1];
}

function updateCronBaseUrl(projectName) {
  let text = fs.readFileSync(CRON_CONFIG, 'utf8');
  const url = `https://${projectName}.pages.dev`;
  text = text.replace(/^PAGES_BASE_URL\s*=\s*["'][^"']*["']/m, `PAGES_BASE_URL = "${url}"`);
  fs.writeFileSync(CRON_CONFIG, text, 'utf8');
}

function main() {
  const projectName = readName(PAGE_CONFIG);
  updateCronBaseUrl(projectName);

  console.log('[setup:pages:cron] 部署轻量 Cron Bridge Worker...');
  run(['deploy', '--config', 'wrangler.pages-cron.toml'], { inherit: true });

  const secret = String(process.env.SUBSTRACKER_CRON_SECRET || '').trim() || crypto.randomBytes(32).toString('base64url');
  console.log('[setup:pages:cron] 同步 Pages / Cron Worker 调度密钥...');
  run(['pages', 'secret', 'put', 'SUBSTRACKER_CRON_SECRET', '--project-name', projectName], { input: `${secret}\n` });
  run(['secret', 'put', 'SUBSTRACKER_CRON_SECRET', '--config', 'wrangler.pages-cron.toml'], { input: `${secret}\n` });

  console.log('[setup:pages:cron] 完成 ✅');
  console.log('[setup:pages:cron] Pages 网站负责 UI/API；辅助 Worker 只负责每小时触发调度。');
}

try {
  main();
} catch (error) {
  console.error('[setup:pages:cron] 失败:', error?.message || error);
  process.exit(1);
}
