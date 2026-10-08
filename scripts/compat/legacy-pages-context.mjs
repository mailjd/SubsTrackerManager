/**
 * Targeted compatibility repair for a legacy src/pages-handler.js retained by
 * an overlay update. The release ZIP does not otherwise contain that file.
 *
 * This is NOT a general source formatter or a TypeScript error suppressor.
 * It only inserts `props: {}` into the exact two-method object identified by
 * an actual ExecutionContext/missing-props diagnostic. Method bodies, exports,
 * imports, receiver binding and every other byte are preserved.
 * No credentials, remote APIs, business records or deployment state are used.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TARGET = 'src/pages-handler.js';
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
function fail(message) { throw new Error('ST_CONTEXT_REPAIR: ' + message); }
function propertyName(ts, node) {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null;
}
function missingProps(ts, diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  return [2345, 2741, 2739, 2322].includes(diagnostic.code)
    && /ExecutionContext/.test(message) && /'props'/.test(message)
    && /missing/.test(message);
}
function unwrap(ts, node) {
  while (node && ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}
function resolveObject(ts, checker, node) {
  node = unwrap(ts, node);
  if (node && ts.isObjectLiteralExpression(node)) return node;
  if (!node || !ts.isIdentifier(node)) return null;
  const declarations = checker.getSymbolAtLocation(node)?.declarations;
  if (!declarations || declarations.length !== 1) return null;
  const declaration = declarations[0];
  // Do not follow factories, imports, aliases, mutable/reassigned objects or casts.
  if (!ts.isVariableDeclaration(declaration)
      || !ts.isVariableDeclarationList(declaration.parent)
      || !(declaration.parent.flags & ts.NodeFlags.Const)) return null;
  const value = unwrap(ts, declaration.initializer);
  return value && ts.isObjectLiteralExpression(value) ? value : null;
}
function diagnosticObject(ts, checker, source, diagnostic) {
  if (diagnostic.start == null) return null;
  let leaf = source;
  function visit(node) {
    if (node.getStart(source) <= diagnostic.start && diagnostic.start < node.end) {
      leaf = node;
      ts.forEachChild(node, visit);
    }
  }
  visit(source);
  for (let node = leaf; node && node !== source; node = node.parent) {
    const object = resolveObject(ts, checker, node);
    if (object) return object;
    if (ts.isVariableDeclaration(node)) return resolveObject(ts, checker, node.name);
    // The diagnostic must be on the value itself, not a guessed neighbouring call.
    if (ts.isCallExpression(node) || ts.isStatement(node)) break;
  }
  return null;
}
function eligible(ts, object) {
  if (!object || object.properties.length !== 2) return false;
  const names = object.properties.map(p => {
    if (ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p)
        || ts.isShorthandPropertyAssignment(p)) return propertyName(ts, p.name);
    return null;
  });
  return names.includes('waitUntil') && names.includes('passThroughOnException');
}
function programFor(ts, root, override) {
  const configPath = path.join(root, 'jsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) fail('无法读取 jsconfig.json；未修改源文件。');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
  if (parsed.errors.length) fail('jsconfig.json 无效；未修改源文件。');
  const host = ts.createCompilerHost(parsed.options);
  if (override) {
    const read = host.readFile.bind(host);
    host.readFile = file => path.resolve(file) === override.file ? override.text : read(file);
  }
  return ts.createProgram({rootNames: parsed.fileNames, options: {...parsed.options, noEmit: true}, host});
}

/** Parse/type-check first, then save one minimal local patch atomically.
 * @param {string} root Project directory containing jsconfig.json.
 * @param {object} ts The installed TypeScript compiler API (provided by the CLI).
 * @returns {{status:string, file:string, changed:number, beforeSha256?:string, afterSha256?:string, backup?:string}}
 */
export function repairLegacyPagesContext(root, ts) {
  root = path.resolve(root);
  const file = path.join(root, TARGET);
  if (!fs.existsSync(file)) return {status: 'absent', file: TARGET, changed: 0};
  for (const part of [root, path.join(root, 'src'), file]) {
    if (fs.lstatSync(part).isSymbolicLink()) fail('目标路径包含符号链接；未修改。');
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) fail('目标不是可处理的普通 JS 文件；未修改。');
  const original = fs.readFileSync(file, 'utf8');
  const program = programFor(ts, root);
  const source = program.getSourceFile(file);
  if (!source) fail('目标不在现有 jsconfig 范围；不会排除文件或修改检查配置。');
  if (program.getSyntacticDiagnostics(source).length) fail('目标已有语法错误；未修改，请检查原文件。');
  const diagnostics = program.getSemanticDiagnostics(source);
  const relevant = diagnostics.filter(d => missingProps(ts, d));
  if (!relevant.length) return {status: 'unchanged', file: TARGET, changed: 0};
  const checker = program.getTypeChecker();
  const starts = new Set();
  for (const diagnostic of relevant) {
    const object = diagnosticObject(ts, checker, source, diagnostic);
    if (!eligible(ts, object)) {
      fail('发现缺少 props 的 ExecutionContext，但不是已验证的两方法对象；未改写。请保留原 src/pages-handler.js 核对，不能跳过 lint。');
    }
    starts.add(object.getStart(source) + 1);
  }
  let repaired = original;
  for (const at of [...starts].sort((a, b) => b - a)) {
    repaired = repaired.slice(0, at) + ' props: {},' + repaired.slice(at);
  }
  // The new property must really satisfy the current declared type. For example,
  // a context requiring props.tenant must not receive an invented empty tenant.
  const afterProgram = programFor(ts, root, {file, text: repaired});
  const afterSource = afterProgram.getSourceFile(file);
  if (!afterSource || afterProgram.getSyntacticDiagnostics(afterSource).length) {
    fail('修补后的语法校验失败；原文件保持不变。');
  }
  const beforeOther = new Map();
  const key = d => d.code + ':' + ts.flattenDiagnosticMessageText(d.messageText, '\n');
  for (const d of diagnostics.filter(d => !missingProps(ts, d))) beforeOther.set(key(d), (beforeOther.get(key(d)) || 0) + 1);
  for (const d of afterProgram.getSemanticDiagnostics(afterSource)) {
    if (missingProps(ts, d) || !(beforeOther.get(key(d)) > 0)) {
      fail('空 props 不满足目标的实际类型或引入新错误；原文件保持不变，请核对该文件。');
    }
    beforeOther.set(key(d), beforeOther.get(key(d)) - 1);
  }
  if (fs.readFileSync(file, 'utf8') !== original) fail('源文件在检查期间发生变化；未覆盖。');
  const beforeSha256 = sha256(original), afterSha256 = sha256(repaired);
  const backupDir = path.join(root, '.compat-backups');
  if (fs.existsSync(backupDir) && fs.lstatSync(backupDir).isSymbolicLink()) fail('备份目录不可为符号链接。');
  fs.mkdirSync(backupDir, {recursive: true, mode: 0o700});
  const backup = path.join(backupDir, 'pages-handler.' + beforeSha256 + '.js');
  if (fs.existsSync(backup)) {
    if (fs.lstatSync(backup).isSymbolicLink() || fs.readFileSync(backup, 'utf8') !== original) fail('已有本机修补备份冲突；未修改。');
  } else fs.writeFileSync(backup, original, {flag: 'wx', mode: 0o600});
  const temp = path.join(root, 'src', '.pages-handler.' + crypto.randomUUID() + '.tmp');
  try {
    fs.writeFileSync(temp, repaired, {flag: 'wx', mode: stat.mode & 0o777});
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return {status: 'repaired', file: TARGET, changed: starts.size, beforeSha256, afterSha256,
    backup: path.relative(root, backup).split(path.sep).join('/')};
}
