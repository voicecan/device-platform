import { argon2, createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ARGON_PARAMETERS = { parallelism: 4, tagLength: 32, memory: 65_536, passes: 3 } as const;

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: password, nonce: salt, ...ARGON_PARAMETERS }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) throw new Error('PASSWORD_POLICY_FAILED');
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return `argon2id$v=1$m=${ARGON_PARAMETERS.memory},t=${ARGON_PARAMETERS.passes},p=${ARGON_PARAMETERS.parallelism}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 5 || parts[0] !== 'argon2id') return false;
  const salt = Buffer.from(parts[3]!, 'base64url');
  const expected = Buffer.from(parts[4]!, 'base64url');
  const actual = await derivePassword(password, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function tokenHash(token: string, pepper?: Uint8Array): string {
  return pepper
    ? createHmac('sha256', pepper).update(token).digest('hex')
    : createHmac('sha256', 'voicecan-opaque-token-v1').update(token).digest('hex');
}

export function encodeDeviceToken(token: Uint8Array): string {
  if (token.byteLength !== 32) throw new Error('DEVICE_TOKEN_LENGTH');
  return Buffer.from(token).toString('base64');
}

export function decodeDeviceToken(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('DEVICE_TOKEN_ENCODING');
  const token = Buffer.from(value, 'base64');
  if (token.byteLength !== 32 || token.toString('base64') !== value) throw new Error('DEVICE_TOKEN_ENCODING');
  return token;
}

export function deviceTokenVerifier(token: Uint8Array, pepper: Uint8Array): string {
  if (token.byteLength !== 32) throw new Error('DEVICE_TOKEN_LENGTH');
  return createHmac('sha256', pepper)
    .update('voicecan-device-token-v1\0')
    .update(token)
    .digest('hex');
}

export function encryptSecret(secret: Uint8Array | string, masterKey: Buffer, aad: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [nonce, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptSecret(encoded: string, masterKey: Buffer, aad: string): Buffer {
  const [nonceValue, tagValue, ciphertextValue] = encoded.split('.');
  if (!nonceValue || !tagValue || !ciphertextValue) throw new Error('INVALID_CIPHERTEXT');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(nonceValue, 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, 'base64url')), decipher.final()]);
}

export function decryptSecretWithKeyring(encoded: string, keys: ReadonlyMap<number, Buffer>, aad: string, preferredVersion?: number): Buffer {
  const candidates = preferredVersion === undefined
    ? [...keys.entries()]
    : [[preferredVersion, keys.get(preferredVersion)] as const, ...[...keys.entries()].filter(([version]) => version !== preferredVersion)];
  for (const [, key] of candidates) {
    if (!key) continue;
    try { return decryptSecret(encoded, key, aad); } catch { /* try the retained recovery key */ }
  }
  throw new Error('MASTER_KEY_UNAVAILABLE');
}
