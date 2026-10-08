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

/** Runtime-only independent SuperAdmin identity. Never reads credentials from KV,
 * process.env, the ordinary admin configuration, or a hard-coded fallback.
 * @param {any} env
 * @returns {{ username: string, password: string, configured?: boolean } | null}
 */
export function getRuntimeSuperAdminCredentials(env) {
  const username = typeof env?.SUBSTRACKER_SUPERADMIN_USERNAME === 'string'
    ? env.SUBSTRACKER_SUPERADMIN_USERNAME.trim() : '';
  const password = getRuntimeSuperAdminPassword(env);
  // Do not trim a password: whitespace is part of the secret.
  if (!username || !password) return null;
  // An older Workers-facing client checks `.configured === true`.  Keep the
  // original enumerable {username,password} shape for existing consumers and
  // JSON snapshots, but provide the compatibility status through an own,
  // non-enumerable, immutable property.  Never emit this object to a response.
  return Object.defineProperty({ username, password }, 'configured', {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false
  });
}

/** Compatibility API expected by repositories with an independent runtime username.
 * Missing/partial settings or invalid inputs always deny authentication.
 * Both identity and secret are checked without logging either value.
 * @param {any} env
 * @param {unknown} username
 * @param {unknown} password
 * @returns {Promise<boolean>}
 */
export async function verifyRuntimeSuperAdminCredentials(env, username, password) {
  const expected = getRuntimeSuperAdminCredentials(env);
  if (!expected || typeof username !== 'string' || !username ||
      typeof password !== 'string' || !password) return false;
  const [actualUser, wantedUser, actualPassword, wantedPassword] = await Promise.all([
    sha256Bytes(username), sha256Bytes(expected.username),
    sha256Bytes(password), sha256Bytes(expected.password)
  ]);
  const userMatches = constantTimeEqual(actualUser, wantedUser);
  const passwordMatches = constantTimeEqual(actualPassword, wantedPassword);
  return userMatches && passwordMatches;
}
