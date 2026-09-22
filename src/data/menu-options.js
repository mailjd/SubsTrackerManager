import { getKVJson, putKVJson } from './kv.js';
import { ensureD1Schema, hasD1Binding } from './d1-schema.js';

const LEGACY_KEY = 'menu_options_v1';
const MAX_OPTION_LENGTH = 120;
const MAX_OPTIONS_PER_GROUP = 500;

export const MENU_DEFAULTS = Object.freeze({
  subscriptionNames: [
    'Tapnow', 'LibTV', '即梦', '豆包', '小云雀', 'SUNO', '剪映', 'AdobeCC',
    'ChatGPT', 'Gemini', 'higgsfield', 'LovArt', 'Askgo', 'Midjourney',
    'TopazLabs', 'ClaudeCode(CC)', '19584618860', '19042608266', '配音', '千问办公'
  ],
  subscriptionTypes: ['开会员', '充积分', '充话费', '服务费用', '配音费用'],
  categories: ['未完成', '钉钉报销中', '已完成', '未还代支付'],
  memberLevels: [
    '高级会员',
    '豪华版VIP会员',
    '专业版会员',
    'Ultimate会员',
    'Ultra会员',
    'Pro会员',
    'Plus会员',
    'Pro5X会员',
    '摄影计划（1 TB）',
    '团队会员',
    'TopazStudio',
    '至尊版VIP会员(升级)',
    '个人标准版',
    'Standard Plan'
  ],
  users: [
    '张重华', '向芸', '邱展金', '李玉蓉', '郑会锦', '李家乐', '王崴', '韦良志', '黄晓', '李钊',
    '杨泽宇', '周鑫', '蔡锦昌', '王子豪', '刘靖磊', '王乙', '林舜才', '王静秋', '谢金金', '陈成颖',
    '吕洁', '刘哲', '袁鑫', '尹嘉慧', '林钦豪', '陈博源', '黄一一', '林佳楠', '雷嘉慧', '刘乾',
    '王子怡', '黄维静', '吴丽君', '郑欣钒', '刘语欣', '林瑾', '盛芳', '王跃', '胡钢', '李叶',
    '曾碧华', '秦琦', '卢洁铭', '许建丁', '蔡慧娴'
  ]
});

const GROUPS = Object.freeze(Object.keys(MENU_DEFAULTS));
const GROUP_SET = new Set(GROUPS);

let d1MenusInitPromise = null;

function cleanOption(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_OPTION_LENGTH) : '';
}

function normalizeList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const item = cleanOption(raw);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= MAX_OPTIONS_PER_GROUP) break;
  }
  return out;
}

function normalizeStored(raw) {
  const hasStoredObject = raw && typeof raw === 'object' && !Array.isArray(raw);
  const result = {};
  for (const group of GROUPS) {
    const source = hasStoredObject && Object.prototype.hasOwnProperty.call(raw, group)
      ? raw[group]
      : MENU_DEFAULTS[group];
    result[group] = normalizeList(source);
  }
  return result;
}

export function isValidMenuGroup(group) {
  return GROUP_SET.has(group);
}

async function getLegacyMenus(env) {
  try {
    return await getKVJson(env, LEGACY_KEY);
  } catch {
    return null;
  }
}

async function ensureD1MenusInitialized(env) {
  if (d1MenusInitPromise) return d1MenusInitPromise;

  d1MenusInitPromise = (async () => {
    await ensureD1Schema(env);
    const db = env.SUBSCRIPTIONS_DB;
    const legacy = await getLegacyMenus(env);
    const now = new Date().toISOString();

    for (const group of GROUPS) {
      const marker = await db.prepare('SELECT group_key FROM menu_option_groups WHERE group_key = ?').bind(group).first();
      if (marker) continue;

      const source = legacy && typeof legacy === 'object' && Object.prototype.hasOwnProperty.call(legacy, group)
        ? legacy[group]
        : MENU_DEFAULTS[group];
      const items = normalizeList(source);
      const statements = [
        db.prepare('INSERT OR IGNORE INTO menu_option_groups (group_key, initialized_at, updated_at) VALUES (?, ?, ?)')
          .bind(group, now, now)
      ];
      items.forEach((value, index) => {
        statements.push(
          db.prepare(`INSERT OR IGNORE INTO menu_options (group_key, value, sort_order, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?)`)
            .bind(group, value, index, now, now)
        );
      });
      await db.batch(statements);
    }
    return true;
  })().catch((error) => {
    d1MenusInitPromise = null;
    throw error;
  });

  return d1MenusInitPromise;
}

async function getD1Menus(env) {
  await ensureD1MenusInitialized(env);
  const result = {};
  for (const group of GROUPS) result[group] = [];
  const rows = await env.SUBSCRIPTIONS_DB.prepare(`
    SELECT group_key, value
    FROM menu_options
    ORDER BY group_key ASC, sort_order ASC, rowid ASC
  `).all();
  for (const row of rows.results || []) {
    const group = String(row.group_key || '');
    if (!isValidMenuGroup(group)) continue;
    const value = cleanOption(row.value);
    if (value && !result[group].includes(value)) result[group].push(value);
  }
  return result;
}

async function getFallbackMenus(env) {
  const stored = await getLegacyMenus(env);
  const normalized = normalizeStored(stored);
  if (!stored || JSON.stringify(stored) !== JSON.stringify(normalized)) {
    await putKVJson(env, LEGACY_KEY, normalized);
  }
  return normalized;
}

/**
 * 读取可配置菜单。D1 为主存储；仅在 D1 未绑定时回退旧 KV。
 * @param {any} env
 */
export async function getMenuOptions(env) {
  return hasD1Binding(env) ? getD1Menus(env) : getFallbackMenus(env);
}

/** @param {any} env @param {string} group @param {string} value */
export async function addMenuOption(env, group, value, options = {}) {
  if (!isValidMenuGroup(group)) throw new Error('无效的菜单分组');
  const item = cleanOption(value);
  if (!item) throw new Error('菜单项不能为空');

  if (!hasD1Binding(env)) {
    const all = await getFallbackMenus(env);
    if (!all[group].includes(item)) {
      if (all[group].length >= MAX_OPTIONS_PER_GROUP) throw new Error('菜单项数量已达到上限');
      all[group].push(item);
      await putKVJson(env, LEGACY_KEY, all);
    }
    return options.returnMenus === false ? null : all;
  }

  await ensureD1MenusInitialized(env);
  const db = env.SUBSCRIPTIONS_DB;

  const existing = await db.prepare(
    'SELECT 1 AS found FROM menu_options WHERE group_key = ? AND value = ? LIMIT 1'
  ).bind(group, item).first();
  if (existing) return options.returnMenus === false ? null : getD1Menus(env);

  const count = await db.prepare('SELECT COUNT(*) AS count FROM menu_options WHERE group_key = ?').bind(group).first();
  if (Number(count?.count || 0) >= MAX_OPTIONS_PER_GROUP) throw new Error('菜单项数量已达到上限');
  const maxRow = await db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM menu_options WHERE group_key = ?').bind(group).first();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO menu_options (group_key, value, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)`)
      .bind(group, item, Number(maxRow?.max_sort ?? -1) + 1, now, now),
    db.prepare('UPDATE menu_option_groups SET updated_at = ? WHERE group_key = ?').bind(now, group)
  ]);
  return options.returnMenus === false ? null : getD1Menus(env);
}

/** @param {any} env @param {string} group @param {string} value */
export async function removeMenuOption(env, group, value) {
  if (!isValidMenuGroup(group)) throw new Error('无效的菜单分组');
  const item = cleanOption(value);
  if (!item) throw new Error('菜单项不能为空');

  if (!hasD1Binding(env)) {
    const all = await getFallbackMenus(env);
    all[group] = all[group].filter((entry) => entry !== item);
    await putKVJson(env, LEGACY_KEY, all);
    return all;
  }

  await ensureD1MenusInitialized(env);
  const now = new Date().toISOString();
  await env.SUBSCRIPTIONS_DB.batch([
    env.SUBSCRIPTIONS_DB.prepare('DELETE FROM menu_options WHERE group_key = ? AND value = ?').bind(group, item),
    env.SUBSCRIPTIONS_DB.prepare('UPDATE menu_option_groups SET updated_at = ? WHERE group_key = ?').bind(now, group)
  ]);
  return getD1Menus(env);
}

/** @param {any} env @param {string|null} group */
export async function resetMenuOptions(env, group = null) {
  if (group != null && !isValidMenuGroup(group)) throw new Error('无效的菜单分组');
  const targets = group ? [group] : [...GROUPS];

  if (!hasD1Binding(env)) {
    const all = await getFallbackMenus(env);
    for (const key of targets) all[key] = [...MENU_DEFAULTS[key]];
    await putKVJson(env, LEGACY_KEY, all);
    return all;
  }

  await ensureD1MenusInitialized(env);
  const db = env.SUBSCRIPTIONS_DB;
  const now = new Date().toISOString();
  const statements = [];
  for (const key of targets) {
    statements.push(db.prepare('DELETE FROM menu_options WHERE group_key = ?').bind(key));
    MENU_DEFAULTS[key].forEach((value, index) => {
      statements.push(db.prepare(`INSERT INTO menu_options (group_key, value, sort_order, created_at, updated_at)
                                  VALUES (?, ?, ?, ?, ?)`)
        .bind(key, value, index, now, now));
    });
    statements.push(db.prepare(`INSERT INTO menu_option_groups (group_key, initialized_at, updated_at)
                                VALUES (?, ?, ?)
                                ON CONFLICT(group_key) DO UPDATE SET updated_at = excluded.updated_at`)
      .bind(key, now, now));
  }
  await db.batch(statements);
  return getD1Menus(env);
}

/**
 * 备份恢复使用：完整覆盖所有菜单组。旧备份缺少的新组自动使用默认值。
 * @param {any} env
 * @param {any} value
 */
export async function setMenuOptions(env, value) {
  const normalized = normalizeStored(value || {});
  if (!hasD1Binding(env)) {
    await putKVJson(env, LEGACY_KEY, normalized);
    return normalized;
  }

  await ensureD1MenusInitialized(env);
  const db = env.SUBSCRIPTIONS_DB;
  const now = new Date().toISOString();
  const statements = [];
  for (const group of GROUPS) {
    statements.push(db.prepare('DELETE FROM menu_options WHERE group_key = ?').bind(group));
    normalized[group].forEach((item, index) => {
      statements.push(db.prepare(`INSERT INTO menu_options (group_key, value, sort_order, created_at, updated_at)
                                  VALUES (?, ?, ?, ?, ?)`)
        .bind(group, item, index, now, now));
    });
    statements.push(db.prepare(`INSERT INTO menu_option_groups (group_key, initialized_at, updated_at)
                                VALUES (?, ?, ?)
                                ON CONFLICT(group_key) DO UPDATE SET updated_at = excluded.updated_at`)
      .bind(group, now, now));
  }
  await db.batch(statements);
  return getD1Menus(env);
}
