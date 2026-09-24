/** Table edits are explicit assignments, not renewal commands.
 * Keep input normalization independent of storage so that verification compares
 * the user's normalized intent, never an object that the updater already changed.
 */
import { parseDateInputInTimezone, formatDateInputInTimezone } from '../core/time.js';
import { normalizeRule } from './reminders.repo.js';

const TEXT = new Set(['name','account','accountSerial','memberLevel','users','customType','category','notes']);
const BOOL = new Set(['useLunar','endOfMonth','isActive','autoRenew']);
const NUM = new Set(['points','amount','periodValue','reminderValue','reminderDays','reminderHours']);
const ENUM = {
  subscriptionMode: ['cycle','reset'], periodUnit: ['single','day','month','year'],
  currency: ['CNY','USD','HKD','TWD','JPY','EUR','GBP','KRW','TRY'], reminderUnit: ['day','hour']
};
const DATES = new Set(['startDate','expiryDate']);
const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);

export function canonicalRules(rules) {
  if (!Array.isArray(rules)) return null;
  return rules.map((r) => ({type:r.type,value:Number(r.value),unit:r.unit,
    repeatInterval:r.repeatInterval == null ? null : Number(r.repeatInterval),
    repeatUntil:r.repeatUntil || 'renewed',isEnabled:r.isEnabled !== false
  })).map((r)=>JSON.stringify(r)).sort();
}

export function normalizeTableChanges(input, timezone = 'Asia/Shanghai') {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) throw new Error('没有待保存的表格修改');
  const out = {};
  for (const [field,raw] of Object.entries(input)) {
    if (TEXT.has(field)) {
      if (raw != null && typeof raw !== 'string') throw new Error(`${field} 必须是文本`);
      let value = raw == null ? '' : raw;
      if (field !== 'notes') value = value.trim();
      if (field === 'name' && !value) throw new Error('订阅名称不能为空');
      if (field === 'users') value = [...new Set(value.split(/[,，]/).map(x=>x.trim()).filter(Boolean))].join(',');
      out[field] = value;
    } else if (BOOL.has(field)) {
      if (typeof raw !== 'boolean') throw new Error(`${field} 必须是“是/否”布尔值`);
      out[field] = raw;
    } else if (NUM.has(field)) {
      if ((field === 'points' || field === 'amount') && (raw === '' || raw == null)) { out[field] = null; continue; }
      if (raw === '' || raw == null || !['number','string'].includes(typeof raw)) throw new Error(`${field} 必须是有效数值`);
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || (field === 'periodValue' && (!Number.isInteger(n) || n < 1))) throw new Error(`${field} 数值无效（周期必须为正整数）`);
      out[field] = n;
    } else if (own(ENUM,field)) {
      const value = String(raw == null ? '' : raw).trim();
      if (!ENUM[field].includes(value)) throw new Error(`${field} 不在允许的选项内`);
      out[field] = value;
    } else if (DATES.has(field)) {
      if (field === 'startDate' && (raw === '' || raw == null)) { out[field] = null; continue; }
      if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${field} 日期不能为空`);
      const date = parseDateInputInTimezone(raw,timezone);
      if (Number.isNaN(date.getTime())) throw new Error(`${field} 日期格式无效`);
      const parts = raw.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (parts) {
        const intended = `${parts[1]}-${parts[2].padStart(2,'0')}-${parts[3].padStart(2,'0')}`;
        if (formatDateInputInTimezone(date,timezone) !== intended) throw new Error(`${field} 不是有效的日历日期`);
      }
      out[field] = date.toISOString();
    } else if (field === 'reminderRules') {
      if (!Array.isArray(raw) || raw.length > 100) throw new Error('提醒规则必须为数组，最多100条');
      for (const rule of raw) {
        if (!rule || !['before_expiry','on_expiry','after_expiry'].includes(rule.type) || !['days','hours'].includes(rule.unit) ||
          !Number.isInteger(rule.value) || rule.value < 0 || (rule.isEnabled !== undefined && typeof rule.isEnabled !== 'boolean') ||
          (rule.repeatInterval != null && (!Number.isInteger(rule.repeatInterval) || rule.repeatInterval <= 0)) ||
          (rule.repeatUntil != null && !['renewed','acknowledged','never'].includes(rule.repeatUntil))) throw new Error('提醒规则格式无效，未写入修改');
      }
      out[field] = raw.map(normalizeRule);
    } else {
      throw new Error(`不允许编辑字段：${field}`);
    }
  }
  return out;
}

export function mismatchedTableFields(snapshot, expected, timezone = 'Asia/Shanghai') {
  if (!snapshot) return Object.keys(expected);
  return Object.keys(expected).filter((field) => {
    let a=snapshot[field], b=expected[field];
    if (field === 'reminderRules') return JSON.stringify(canonicalRules(a)) !== JSON.stringify(canonicalRules(b));
    if (DATES.has(field)) {
      if (a == null || a === '') a=null; else a=formatDateInputInTimezone(a,timezone);
      if (b == null || b === '') b=null; else b=formatDateInputInTimezone(b,timezone);
    }
    return JSON.stringify(a) !== JSON.stringify(b);
  });
}
