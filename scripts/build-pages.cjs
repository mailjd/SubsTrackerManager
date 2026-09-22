#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const required = [
  'public/_routes.json',
  'public/js/lib/api-client.js',
  'functions/index.js',
  'functions/[[path]].js',
  'src/pages-handler.js',
  'wrangler.toml'
];

for (const rel of required) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.error(`[build:pages] 缺少必要文件：${rel}`);
    process.exit(1);
  }
}

const routes = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/_routes.json'), 'utf8'));
if (!Array.isArray(routes.include) || routes.version !== 1) {
  console.error('[build:pages] public/_routes.json 格式无效');
  process.exit(1);
}

console.log('[build:pages] Cloudflare Pages 构建检查完成 ✅');
console.log('[build:pages] 静态目录：public/');
console.log('[build:pages] 动态入口：functions/index.js + functions/[[path]].js');
