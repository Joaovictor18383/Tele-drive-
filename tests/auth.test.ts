import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, SignJWT } from 'jose';
import bigInt from 'big-integer';
import { Api, type TelegramClient } from 'telegram';
import { createApp } from '../server/app';
import { Telegram } from '../server/telegram';
import { parseTelegramCredentials, pasteTelegramField } from '../src/lib/telegram-credentials';
import { authorizationUrl, challenge, issuer, sameTelegramAccount, sessionCipher, verifyIdentity } from '../server/security';

test('desktop setup recognizes both Telegram values in one paste', () => {
  const hash = '0123456789abcdef0123456789abcdef';
  const pair = { apiId: '112233', apiHash: hash };
  assert.deepEqual(parseTelegramCredentials(`App api_id:\r\n112233\r\nApp api_hash:\r\n${hash}\r\nApp title: CloudVault`), pair);
  assert.deepEqual(parseTelegramCredentials(`TELEGRAM_API_ID=112233\nTELEGRAM_API_HASH="${hash}"`), pair);
  assert.deepEqual(parseTelegramCredentials(`112233\t${hash}`), pair);
  assert.deepEqual(parseTelegramCredentials(`${hash}\t112233`), pair);
  assert.equal(parseTelegramCredentials(`api_id: 112233\napi_id: 998877\napi_hash: ${hash}`), undefined);
  assert.equal(parseTelegramCredentials(`api_id: 3000000000\napi_hash: ${hash}`), undefined);
  assert.equal(parseTelegramCredentials(`api_id: 112233\napi_hash: ${hash}g`), undefined);
  assert.equal(parseTelegramCredentials('112233'), undefined);
});

test('desktop setup identifies a single ID or hash independently of the selected field', () => {
  const hash = 'fedcba9876543210fedcba9876543210';
  assert.deepEqual(pasteTelegramField('App api_id:\n112233'), { field: 'apiId', value: '112233' });
  assert.deepEqual(pasteTelegramField(`App api_hash:\n${hash}`), { field: 'apiHash', value: hash });
  assert.deepEqual(pasteTelegramField(hash), { field: 'apiHash', value: hash });
  assert.equal(pasteTelegramField('8cbf6d'), undefined);
  assert.equal(pasteTelegramField(`App api_id: 112233\nApp api_hash: ${hash}`), undefined);
});

test('OIDC uses the official endpoint with S256, state, and nonce', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const hash = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  assert.equal(challenge(verifier), hash);
  const url = new URL(authorizationUrl('123', 'https://vault.test/api/auth/callback', 'state', verifier, 'nonce'));
  assert.equal(url.origin, issuer);
  assert.equal(url.pathname, '/auth');
  assert.equal(url.searchParams.get('scope'), 'openid profile');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), hash);
  assert.equal(url.searchParams.get('state'), 'state');
  assert.equal(url.searchParams.get('nonce'), 'nonce');
  assert(!url.href.includes(verifier));
});

test('requires a verified ID token and an exact Telegram account match', async () => {
  const keys = await generateKeyPair('RS256');
  const alt = await generateKeyPair('RS256');
  const resolve = async () => keys.publicKey;
  const sign = (id: string | number, nonce: string, signingKey = keys.privateKey, audience = '123', tokenIssuer = issuer, expiration: number | string = '5m') =>
    new SignJWT({ id, nonce, name: 'Test user', picture: 'https://cdn4.telesco.pe/avatar.jpg' })
      .setProtectedHeader({ alg: 'RS256' }).setIssuer(tokenIssuer).setAudience(audience)
      .setSubject('opaque-oidc-subject').setIssuedAt().setExpirationTime(expiration).sign(signingKey);
  const profile = await verifyIdentity(await sign(123456, 'nonce'), '123', 'nonce', resolve);
  assert.equal(profile.id, '123456');
  assert(sameTelegramAccount(profile, '123456'));
  assert(!sameTelegramAccount(profile, '123457'));
  assert(!sameTelegramAccount(profile, 'opaque-oidc-subject'));
  await assert.rejects(verifyIdentity(await sign(123456, 'different'), '123', 'nonce', resolve));
  await assert.rejects(verifyIdentity(await sign(123456, 'nonce', alt.privateKey), '123', 'nonce', resolve));
  await assert.rejects(verifyIdentity(await sign(123456, 'nonce', keys.privateKey, '456'), '123', 'nonce', resolve));
  await assert.rejects(verifyIdentity(await sign(123456, 'nonce', keys.privateKey, '123', 'https://issuer.test'), '123', 'nonce', resolve));
  await assert.rejects(verifyIdentity(await sign(123456, 'nonce', keys.privateKey, '123', issuer, 1), '123', 'nonce', resolve));
});

test('session encryption is authenticated and bound to the cookie ID', () => {
  const cipher = sessionCipher(randomBytes(32));
  const secret = { mtproto: 'private telegram authorization' };
  const encrypted = cipher.encrypt(secret, 'session-a');
  assert(!encrypted.includes(Buffer.from(secret.mtproto)));
  assert.deepEqual(cipher.decrypt(encrypted, 'session-a'), secret);
  assert.throws(() => cipher.decrypt(encrypted, 'session-b'));
  encrypted[28] ^= 0x42;
  assert.throws(() => cipher.decrypt(encrypted, 'session-a'));
});

test('Fastify rejects unauthenticated access, foreign origins, and unconfigured login', async t => {
  const app = await createApp({ PUBLIC_ORIGIN: 'http://localhost:5173' });
  t.after(() => app.close());
  const guest = await app.inject({ url: '/api/session' });
  assert.deepEqual(guest.json(), { configured: false, connected: false });
  assert.equal(guest.headers['cache-control'], 'no-store');
  const journal = await app.inject({ url: '/api/storage/journal' });
  assert.equal(journal.statusCode, 401);
  const forbidden = await app.inject({ method: 'POST', url: '/api/storage/upload', headers: { origin: 'https://other.test' }, payload: { size: 16 } });
  assert.equal(forbidden.statusCode, 403);
  const login = await app.inject({ url: '/api/auth/start' });
  assert.equal(login.statusCode, 503);
  assert.equal(login.json().code, 'SETUP_REQUIRED');
  await assert.rejects(createApp({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://localhost:5173' }));
});

test('OIDC start issues a private transaction cookie and wrong state never exchanges a code', async t => {
  // Credentials are deliberately synthetic and used only in this local injection test.
  const app = await createApp({
    PUBLIC_ORIGIN: 'https://vault.test', TELEGRAM_API_ID: '100',
    TELEGRAM_API_HASH: randomBytes(16).toString('hex'), TELEGRAM_OIDC_CLIENT_ID: '200',
    TELEGRAM_OIDC_CLIENT_SECRET: 'fixture', SESSION_KEY: randomBytes(32).toString('hex')
  });
  t.after(() => app.close());
  const start = await app.inject({ url: '/api/auth/start' });
  assert.equal(start.statusCode, 302);
  const cookie = String(start.headers['set-cookie']);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Lax/i);
  const url = new URL(String(start.headers.location));
  const key = cookie.split(';')[0];
  const invalid = await app.inject({ url: '/api/auth/callback?code=fixture&state=wrong', headers: { cookie: key } });
  assert.equal(invalid.headers.location, '/?auth=expired');
  const replay = await app.inject({ url: '/api/auth/callback?code=fixture&state=' + url.searchParams.get('state'), headers: { cookie: key } });
  assert.equal(replay.headers.location, '/?auth=expired');
});

test('the Windows QR flow completes the waiting request after Telegram authorizes the scan', { timeout: 7_000 }, async t => {
  const base = await mkdtemp(join(tmpdir(), 'cloudvault-auth-'));
  const origin = 'http://127.0.0.1:5173';
  const launcherToken = randomBytes(32).toString('base64url');
  let update: ((value: unknown) => void) | undefined;
  let approved = false;
  let scanned = { id: 731, firstName: 'Conta QR' };
  class QrFixture extends Telegram {
    protected override makeClient() {
      return {
        connected: true,
        addEventHandler: (receive: (event: unknown) => void) => { update = receive; },
        removeEventHandler: () => undefined,
        destroy: async () => undefined,
        session: { save: () => 'fixture-telegram-session' },
        invoke: async (request: unknown) => {
          if (!(request instanceof Api.auth.ExportLoginToken)) throw new Error('Unexpected fixture command');
          return approved ? new Api.auth.LoginTokenSuccess({
            authorization: new Api.auth.Authorization({ user: new Api.User({ id: bigInt(scanned.id), firstName: scanned.firstName }) })
          }) : new Api.auth.LoginToken({ token: randomBytes(16), expires: Math.floor(Date.now() / 1000) + 30 });
        }
      } as unknown as TelegramClient;
    }
  }
  const env = {
    PUBLIC_ORIGIN: origin, TELEGRAM_API_ID: '100', TELEGRAM_API_HASH: randomBytes(16).toString('hex'),
    SESSION_KEY: randomBytes(32).toString('hex'), SESSION_DIR: base
  };
  const app = await createApp(env, { token: launcherToken, save: async () => undefined, reload: () => undefined },
    (id, hash) => new QrFixture(id, hash));
  const web = await createApp(env);
  t.after(async () => { await app.close(); await web.close(); await rm(base, { recursive: true, force: true }); });
  assert.equal((await web.inject('/api/session')).json().configured, false);
  assert.equal((await app.inject('/api/session')).json().configured, true);
  assert.equal((await app.inject('/api/auth/qr')).statusCode, 404);
  const start = (token: string) => app.inject({ method: 'POST', url: '/api/auth/qr', headers: { origin }, payload: { token } });
  assert.equal((await start(randomBytes(32).toString('base64url'))).statusCode, 403);
  const qr = await start(launcherToken);
  assert.equal(qr.statusCode, 200);
  assert.equal(qr.json().stage, 'qr');
  assert.match(qr.json().image, /^data:image\/png;base64,/);
  const pending = String(qr.headers['set-cookie']).split(';')[0];
  assert.match(pending, /^cv_desktop_qr=/);
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie: pending } })).json().connected, false);
  const response = app.inject({ url: '/api/auth/qr?wait=1', headers: { cookie: pending } });
  const stillWaiting = await Promise.race([response.then(() => false), new Promise<boolean>(resolve => setTimeout(() => resolve(true), 80))]);
  assert.equal(stillWaiting, true);
  approved = true;
  update?.(new Api.UpdateLoginToken());
  const done = await response;
  assert.equal(done.json().stage, 'connected');
  assert.equal(done.json().session.connected, true);
  assert.deepEqual(done.json().session.profile, { id: '731', name: 'Conta QR' });
  const output = done.headers['set-cookie'];
  const session = (Array.isArray(output) ? output : [output]).find(value => value?.startsWith('cv_session='))?.split(';')[0];
  assert(session);
  const linked = (await app.inject({ url: '/api/session', headers: { cookie: session } })).json();
  assert(linked.connected);
  assert.deepEqual(linked.profile, { id: '731', name: 'Conta QR' });

  const switchAccount = () => app.inject({
    method: 'POST', url: '/api/auth/qr', headers: { origin, cookie: session },
    payload: { token: launcherToken, switchAccount: true }
  });
  approved = false;
  const other = await switchAccount();
  assert.equal(other.json().stage, 'qr');
  const otherCookie = String(other.headers['set-cookie']).split(';')[0];
  const cancelled = await app.inject({ method: 'POST', url: '/api/auth/qr/cancel', headers: { origin, cookie: session + '; ' + otherCookie } });
  assert.equal(cancelled.statusCode, 200);
  assert.match(String(cancelled.headers['set-cookie']), /cv_desktop_qr=;/);
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie: session } })).json().profile.id, '731');

  const next = await switchAccount();
  const nextCookie = String(next.headers['set-cookie']).split(';')[0];
  scanned = { id: 732, firstName: 'Outra Conta QR' };
  approved = true;
  update?.(new Api.UpdateLoginToken());
  const switched = await app.inject({ url: '/api/auth/qr', headers: { cookie: session + '; ' + nextCookie } });
  assert.equal(switched.json().session.profile.id, '732');
  const switchedHeaders = switched.headers['set-cookie'];
  const current = (Array.isArray(switchedHeaders) ? switchedHeaders : [switchedHeaders])
    .find(value => value?.startsWith('cv_session='))?.split(';')[0];
  assert(current);
  const staleUpload = await app.inject({
    method: 'POST', url: '/api/storage/upload', headers: { origin, cookie: current, 'x-cloudvault-account': '731' },
    payload: { size: 32 }
  });
  assert.equal(staleUpload.json().code, 'ACCOUNT_CHANGED');
  const staleLogout = await app.inject({
    method: 'POST', url: '/api/auth/logout', headers: { origin, cookie: current, 'x-cloudvault-account': '731' },
    payload: { revoke: true }
  });
  assert.equal(staleLogout.json().code, 'ACCOUNT_CHANGED');
});
