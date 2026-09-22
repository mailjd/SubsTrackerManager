const FORMAT_PREFIX = 'pbkdf2-sha256';
const ITERATIONS = 210000;
const KEY_BYTES = 32;

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password, salt, iterations = ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password || '')),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashSuperAdminPassword(password) {
  const value = String(password || '');
  if (!value) throw new Error('SuperAdmin 二级密码不能为空');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(value, salt, ITERATIONS);
  return `${FORMAT_PREFIX}$${ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(key)}`;
}

export async function verifySuperAdminPassword(password, encoded) {
  const raw = String(encoded || '');
  const parts = raw.split('$');
  if (parts.length !== 4 || parts[0] !== FORMAT_PREFIX) return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 10000 || iterations > 1000000) return false;
  try {
    const salt = base64ToBytes(parts[2]);
    const expected = base64ToBytes(parts[3]);
    const actual = await derive(String(password || ''), salt, iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

function getRuntimeSuperAdminCredentials(env = {}) {
  const username = typeof env?.SUBSTRACKER_SUPERADMIN_USERNAME === 'string'
    ? env.SUBSTRACKER_SUPERADMIN_USERNAME.trim()
    : '';
  const password = typeof env?.SUBSTRACKER_SUPERADMIN_PASSWORD === 'string'
    ? env.SUBSTRACKER_SUPERADMIN_PASSWORD
    : '';
  return {
    username,
    password,
    configured: username.length > 0 && password.length > 0
  };
}

async function digestString(value) {
  const bytes = new TextEncoder().encode(String(value ?? ''));
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function verifyRuntimeSuperAdminCredentials(env, username, password) {
  const runtime = getRuntimeSuperAdminCredentials(env);
  if (!runtime.configured) return false;
  const [actualUser, expectedUser, actualPassword, expectedPassword] = await Promise.all([
    digestString(String(username ?? '').trim()),
    digestString(runtime.username),
    digestString(String(password ?? '')),
    digestString(runtime.password)
  ]);
  return constantTimeEqual(actualUser, expectedUser) && constantTimeEqual(actualPassword, expectedPassword);
}

export { getRuntimeSuperAdminCredentials };
