import { getKVJson, putKVJson } from './kv.js';

const DEFAULT_CONFIG = {
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: '',
  CREDENTIALS_ENCRYPTION_KEY: '',
  SUPERADMIN_PASSWORD_HASH: '',
  TG_BOT_TOKEN: '',
  TG_CHAT_ID: '',
  TG_TOPIC_ID: '',
  NOTIFYX_API_KEY: '',
  WEBHOOK_URL: '',
  WEBHOOK_METHOD: 'POST',
  WEBHOOK_HEADERS: '',
  WEBHOOK_TEMPLATE: '',
  SHOW_LUNAR: false,
  WECHATBOT_WEBHOOK: '',
  WECHATBOT_MSG_TYPE: 'text',
  WECHATBOT_AT_MOBILES: '',
  WECHATBOT_AT_ALL: 'false',
  RESEND_API_KEY: '',
  EMAIL_FROM: '',
  EMAIL_FROM_NAME: '订阅提醒系统',
  EMAIL_TO: '',
  BARK_DEVICE_KEY: '',
  BARK_SERVER: 'https://api.day.app',
  BARK_IS_ARCHIVE: 'false',
  ENABLED_NOTIFIERS: ['notifyx'],
  THEME_MODE: 'system',
  TIMEZONE: 'Asia/Shanghai',
  NOTIFICATION_HOURS: [],
  THIRD_PARTY_API_TOKEN: '',
  DEBUG_LOGS: false,
  PAYMENT_HISTORY_LIMIT: 100,
  GOTIFY_SERVER_URL: '',
  GOTIFY_APP_TOKEN: '',
  SERVERCHAN_SENDKEY: '',
  PUSHPLUS_TOKEN: '',
  PUSHPLUS_TOPIC: '',
  PUSHPLUS_CHANNEL: '',
  NTFY_SERVER: 'https://ntfy.sh',
  NTFY_TOPIC: '',
  NTFY_TOKEN: ''
};


function getRuntimeAdminPassword(env, config = {}) {
  // v3.2.1 起，系统配置页保存的 ADMIN_PASSWORD 为正式登录密码。
  // Cloudflare 的 SUBSTRACKER_ADMIN_PASSWORD 仅作为首次部署/应急登录的兼容回退。
  const configuredPassword = typeof config?.ADMIN_PASSWORD === 'string'
    ? config.ADMIN_PASSWORD
    : '';
  if (configuredPassword) return configuredPassword;

  const workerPassword = typeof env?.SUBSTRACKER_ADMIN_PASSWORD === 'string'
    ? env.SUBSTRACKER_ADMIN_PASSWORD.trim()
    : '';
  return workerPassword;
}

function getAdminPasswordSource(env, config = {}) {
  if (typeof config?.ADMIN_PASSWORD === 'string' && config.ADMIN_PASSWORD.length > 0) return 'system_config';
  const workerPassword = typeof env?.SUBSTRACKER_ADMIN_PASSWORD === 'string'
    ? env.SUBSTRACKER_ADMIN_PASSWORD.trim()
    : '';
  if (workerPassword) return 'cloudflare_fallback';
  return 'not_configured';
}

async function getConfig(env) {
  if (!env.SUBSCRIPTIONS_KV) {
    console.error('[配置] KV存储未绑定');
    throw new Error('KV存储未绑定');
  }
  const data = await env.SUBSCRIPTIONS_KV.get('config');
  console.log('[配置] 从KV读取配置:', data ? '成功' : '空配置');
  const config = data ? JSON.parse(data) : {};

  let jwtSecret = config.JWT_SECRET;
  let credentialsEncryptionKey = config.CREDENTIALS_ENCRYPTION_KEY;
  let configChanged = false;

  if (!jwtSecret) {
    console.log('[配置] 生成新的JWT密钥');
    jwtSecret = crypto.randomUUID();
    config.JWT_SECRET = jwtSecret;
    configChanged = true;
  }

  if (!credentialsEncryptionKey) {
    console.log('[配置] 生成新的订阅凭据加密密钥');
    credentialsEncryptionKey = crypto.randomUUID() + crypto.randomUUID();
    config.CREDENTIALS_ENCRYPTION_KEY = credentialsEncryptionKey;
    configChanged = true;
  }

  if (configChanged) {
    await env.SUBSCRIPTIONS_KV.put('config', JSON.stringify(config));
  }

  return {
    ...DEFAULT_CONFIG,
    ...config,
    JWT_SECRET: jwtSecret,
    CREDENTIALS_ENCRYPTION_KEY: credentialsEncryptionKey
  };
}

async function setConfig(env, config) {
  await putKVJson(env, 'config', config);
}

export {
  DEFAULT_CONFIG,
  getConfig,
  setConfig,
  getRuntimeAdminPassword,
  getAdminPasswordSource
};
