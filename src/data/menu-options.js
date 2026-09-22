import { getKVJson, putKVJson } from './kv.js';

const KEY = 'menu_options_v1';
const MAX_OPTION_LENGTH = 120;
const MAX_OPTIONS_PER_GROUP = 300;

export const MENU_DEFAULTS = Object.freeze({
  subscriptionNames: [
    'Tapnow',
    'LibTV',
    '即梦',
    '豆包',
    '小云雀',
    'SUNO',
    '剪映',
    'AdobeCC',
    'ChatGPT',
    'Gemini',
    'higgsfield',
    'LovArt',
    'Askgo',
    'Midjourney',
    'TopazLabs',
    'ClaudeCode(CC)',
    '19584618860',
    '19042608266',
    '配音',
    '千问办公'
  ],
  subscriptionTypes: [
    '开会员',
    '充积分',
    '充话费',
    '服务费用',
    '配音费用'
  ],
  categories: [
    '未完成',
    '钉钉报销中',
    '已完成',
    '未还代支付'
  ]
});

const GROUPS = new Set(Object.keys(MENU_DEFAULTS));

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
    // 只有整个组从未存在时才使用默认值。空数组代表用户明确删空，不重新补默认项。
    const source = hasStoredObject && Object.prototype.hasOwnProperty.call(raw, group)
      ? raw[group]
      : MENU_DEFAULTS[group];
    result[group] = normalizeList(source);
  }
  return result;
}

export function isValidMenuGroup(group) {
  return GROUPS.has(group);
}

/**
 * 读取三组可配置菜单。首次读取会以当前默认值初始化 KV。
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 */
export async function getMenuOptions(env) {
  const stored = await getKVJson(env, KEY);
  const normalized = normalizeStored(stored);
  if (!stored || JSON.stringify(stored) !== JSON.stringify(normalized)) {
    await putKVJson(env, KEY, normalized);
  }
  return normalized;
}

/**
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} group
 * @param {string} value
 */
export async function addMenuOption(env, group, value) {
  if (!isValidMenuGroup(group)) throw new Error('无效的菜单分组');
  const item = cleanOption(value);
  if (!item) throw new Error('菜单项不能为空');
  const all = await getMenuOptions(env);
  const list = all[group];
  if (!list.includes(item)) {
    if (list.length >= MAX_OPTIONS_PER_GROUP) throw new Error('菜单项数量已达到上限');
    list.push(item);
    await putKVJson(env, KEY, all);
  }
  return all;
}

/**
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string} group
 * @param {string} value
 */
export async function removeMenuOption(env, group, value) {
  if (!isValidMenuGroup(group)) throw new Error('无效的菜单分组');
  const item = cleanOption(value);
  if (!item) throw new Error('菜单项不能为空');
  const all = await getMenuOptions(env);
  all[group] = all[group].filter((entry) => entry !== item);
  await putKVJson(env, KEY, all);
  return all;
}

/**
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {string|null} group
 */
export async function resetMenuOptions(env, group = null) {
  const all = await getMenuOptions(env);
  if (group != null) {
    if (!isValidMenuGroup(group)) throw new Error('无效的菜单分组');
    all[group] = [...MENU_DEFAULTS[group]];
  } else {
    for (const key of GROUPS) all[key] = [...MENU_DEFAULTS[key]];
  }
  await putKVJson(env, KEY, all);
  return all;
}

/**
 * 备份恢复使用：完整覆盖三组菜单。
 * @param {{ SUBSCRIPTIONS_KV: KVNamespace }} env
 * @param {any} value
 */
export async function setMenuOptions(env, value) {
  const normalized = normalizeStored(value || {});
  await putKVJson(env, KEY, normalized);
  return normalized;
}
