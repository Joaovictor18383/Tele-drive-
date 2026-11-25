import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Profile } from '../shared/protocol';

export const issuer = 'https://oauth.telegram.org';
export const telegramKeys = createRemoteJWKSet(new URL('/.well-known/jwks.json', issuer), { timeoutDuration: 8000 });
export const token = () => randomBytes(32).toString('base64url');
export const challenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
export const equal = (a: string, b: string) => {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};

export function authorizationUrl(clientId: string, redirectUri: string, state: string, verifier: string, nonce: string) {
  const url = new URL('/auth', issuer);
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile',
    state, nonce, code_challenge: challenge(verifier), code_challenge_method: 'S256'
  }).toString();
  return url.href;
}

export async function verifyIdentity(jwt: string, audience: string, nonce: string, keys: JWTVerifyGetKey = telegramKeys): Promise<Profile> {
  const { payload } = await jwtVerify(jwt, keys, {
    issuer, audience, algorithms: ['RS256', 'ES256'], requiredClaims: ['exp', 'iat', 'sub', 'nonce'],
    maxTokenAge: '10m', clockTolerance: '10s'
  });
  const id = typeof payload.id === 'number' && Number.isSafeInteger(payload.id)
    ? String(payload.id)
    : typeof payload.id === 'string' ? payload.id : '';
  if (!/^[1-9]\d{0,18}$/.test(id) || payload.nonce !== nonce) throw new Error('IDENTITY_INVALID');
  let picture: string | undefined;
  if (typeof payload.picture === 'string') {
    try {
      const url = new URL(payload.picture);
      if (url.protocol === 'https:' && /(^|\.)(telegram\.org|telesco\.pe|cdn-telegram\.org)$/.test(url.hostname)) picture = url.href;
    } catch { /* Ignore an invalid optional photo. */ }
  }
  return {
    id, picture, name: typeof payload.name === 'string' ? payload.name.slice(0, 150) : 'Telegram',
    username: typeof payload.preferred_username === 'string' ? payload.preferred_username.slice(0, 100) : undefined
  };
}

export function sessionCipher(key: Buffer) {
  if (key.length !== 32) throw new Error('SESSION_KEY_INVALID');
  return {
    encrypt(value: unknown, id: string) {
      const iv = randomBytes(12);
      const gcm = createCipheriv('aes-256-gcm', key, iv);
      gcm.setAAD(Buffer.from('cv1/session/' + id));
      const data = Buffer.concat([gcm.update(JSON.stringify(value), 'utf8'), gcm.final()]);
      return Buffer.concat([iv, gcm.getAuthTag(), data]);
    },
    decrypt<T>(stored: Buffer, id: string): T {
      const gcm = createDecipheriv('aes-256-gcm', key, stored.subarray(0, 12));
      gcm.setAAD(Buffer.from('cv1/session/' + id));
      gcm.setAuthTag(stored.subarray(12, 28));
      return JSON.parse(Buffer.concat([gcm.update(stored.subarray(28)), gcm.final()]).toString('utf8')) as T;
    }
  };
}

export function sameTelegramAccount(profile: Profile, mtprotoId: string) {
  return profile.id === mtprotoId;
}
