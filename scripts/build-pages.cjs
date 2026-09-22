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



// Cloudflare Pages 会在用户 build command 之后再次 bundle /functions。
// 为降低 Pages Git 集成环境因依赖安装异常而失败的风险，运行时源码禁止依赖
// package.json 中的第三方 bare import；Node 内置模块只允许出现在 scripts/ 等构建脚本。
const runtimeRoots = ['src', 'functions'];
const bareImportPattern = /(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+|import\s*\()\s*['"]([^'"./][^'"]*)['"]/g;
const runtimeBareImports = [];

function walkRuntime(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkRuntime(abs);
      continue;
    }
    if (!/\.(?:js|mjs|cjs)$/.test(entry.name)) continue;
    const source = fs.readFileSync(abs, 'utf8');
    let match;
    while ((match = bareImportPattern.exec(source))) {
      runtimeBareImports.push(`${path.relative(ROOT, abs)} -> ${match[1]}`);
    }
    bareImportPattern.lastIndex = 0;
  }
}

for (const rel of runtimeRoots) walkRuntime(path.join(ROOT, rel));
if (runtimeBareImports.length) {
  console.error('[build:pages] 检测到 Pages/Worker 运行时第三方 bare import：');
  for (const item of runtimeBareImports) console.error(`  - ${item}`);
  console.error('[build:pages] 请改为本地模块或在确认 Pages 构建环境会安装该依赖后再提交。');
  process.exit(1);
}

const routes = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/_routes.json'), 'utf8'));
if (!Array.isArray(routes.include) || routes.version !== 1) {
  console.error('[build:pages] public/_routes.json 格式无效');
  process.exit(1);
}

console.log('[build:pages] Cloudflare Pages 构建检查完成 ✅');
console.log('[build:pages] 运行时第三方 bare import：0');
console.log('[build:pages] 静态目录：public/');
console.log('[build:pages] 动态入口：functions/index.js + functions/[[path]].js');
