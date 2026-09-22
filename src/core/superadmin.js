function getRuntimeSuperAdminPassword(env) {
  const value = env && typeof env.SUBSTRACKER_SUPERADMIN_PASSWORD === 'string'
    ? env.SUBSTRACKER_SUPERADMIN_PASSWORD
    : '';
  return value;
}

function constantTimeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256Bytes(value) {
  const data = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

export function hasSuperAdminPassword(env) {
  return getRuntimeSuperAdminPassword(env).length > 0;
}

export async function verifySuperAdminPassword(password, env) {
  const expected = getRuntimeSuperAdminPassword(env);
  if (!expected || typeof password !== 'string' || password.length === 0) return false;
  const [actualHash, expectedHash] = await Promise.all([
    sha256Bytes(password),
    sha256Bytes(expected)
  ]);
  return constantTimeEqual(actualHash, expectedHash);
}
