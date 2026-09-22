/**
 * Subscription credential encryption helpers.
 *
 * Passwords are encrypted at rest with AES-GCM. The encryption key is derived
 * from a per-deployment random secret stored in config.CREDENTIALS_ENCRYPTION_KEY.
 */

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveAesKey(secret) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('凭据加密密钥未配置');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * @param {string} plaintext
 * @param {string} secret
 * @returns {Promise<string>}
 */
export async function encryptCredential(plaintext, secret) {
  if (!plaintext) return '';
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(secret);
  const encoded = new TextEncoder().encode(String(plaintext));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(encrypted))}`;
}

/**
 * @param {string} payload
 * @param {string} secret
 * @returns {Promise<string>}
 */
export async function decryptCredential(payload, secret) {
  if (!payload) return '';
  if (typeof payload !== 'string' || !payload.startsWith('v1:')) {
    throw new Error('不支持的凭据密文格式');
  }

  const parts = payload.split(':');
  if (parts.length !== 3) throw new Error('凭据密文格式无效');

  const iv = base64ToBytes(parts[1]);
  const encrypted = base64ToBytes(parts[2]);
  const key = await deriveAesKey(secret);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
}
