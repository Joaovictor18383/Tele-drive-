import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { header, journalRecord, wireBlock, type SessionState } from '../shared/protocol';
import type { QrResponse, QrState } from '../shared/auth';
import { ApiError } from './errors';
import { authorizationUrl, equal, issuer, token, verifyIdentity } from './security';
import { profileSeconds, Sessions, sessionSeconds, type SiteSession } from './sessions';
import { Telegram } from './telegram';

const oauthCookie = 'cv_oauth';
const sidCookie = 'cv_session';
const desktopQrCookie = 'cv_desktop_qr';
const idString = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const integer = z.coerce.number().int().min(0).max(2147483647);
const routePart = z.object({ id: idString, part: integer.max(7999) });
const remotePart = z.object({ id: integer.min(1), part: integer.max(7999) });
const proof = z.object({
  id: z.string().regex(/^-?[0-9]{1,20}$/),
  a: z.string().regex(/^[A-Za-z0-9_-]{342}$/),
  m1: idString
}).strict();

const desktopCredentials = z.object({
  apiId: z.string().trim().regex(/^[1-9]\d{0,9}$/).refine(value => Number(value) <= 2147483647),
  apiHash: z.string().trim().regex(/^[a-f0-9]{32}$/i)
}).strict();
export type DesktopCredentials = z.infer<typeof desktopCredentials>;
type DesktopSetup = { token: string; save: (credentials: DesktopCredentials) => Promise<void>; reload: () => void };

export async function createApp(
  env: NodeJS.ProcessEnv = process.env, desktop?: DesktopSetup,
  createTelegram = (id: number, hash: string) => new Telegram(id, hash)
) {
  const production = env.NODE_ENV === 'production';
  const publicUrl = new URL(env.PUBLIC_ORIGIN ?? 'http://localhost:5173');
  if (publicUrl.origin !== publicUrl.href.replace(/\/$/, '') ||
      (publicUrl.protocol !== 'https:' && (production || !['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)))) {
    throw new Error('PUBLIC_ORIGIN deve ser uma origem HTTPS em produção.');
  }
  const origin = publicUrl.origin;
  const secure = publicUrl.protocol === 'https:';
  const apiId = Number(env.TELEGRAM_API_ID);
  const apiHash = env.TELEGRAM_API_HASH?.trim() ?? '';
  const clientId = env.TELEGRAM_OIDC_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.TELEGRAM_OIDC_CLIENT_SECRET?.trim() ?? '';
  const key = env.SESSION_KEY?.trim() ?? '';
  const desktopRevision = desktop && !production && !secure ? token() : undefined;
  const configured = Number.isSafeInteger(apiId) && apiId > 0 && /^[a-f0-9]{32}$/i.test(apiHash) &&
    (!!desktopRevision || /^\d+$/.test(clientId) && !!clientSecret) && /^[a-f0-9]{64}$/i.test(key);
  if (production && !configured) throw new Error('Configure as credenciais do Telegram e SESSION_KEY em produção.');
  const store = new Sessions(configured ? Buffer.from(key, 'hex') : randomBytes(32), env.SESSION_DIR ?? '.cloudvault-sessions');
  const telegram = createTelegram(apiId, apiHash);
  const redirectUri = origin + '/api/auth/callback';
  const authFlows = new Map<string, { state: string; verifier: string; nonce: string; expires: number }>();
  const app = Fastify({ logger: true, disableRequestLogging: true, bodyLimit: 1024 * 1024, requestTimeout: 45_000 });

  await app.register(cookie);
  await app.register(helmet, {
    strictTransportSecurity: secure,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'", "'wasm-unsafe-eval'"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.telesco.pe', 'https://telesco.pe', 'https://*.telegram.org', 'https://telegram.org', 'https://*.cdn-telegram.org'],
        mediaSrc: ["'self'", 'blob:'], frameSrc: ["'none'"], objectSrc: ["'none'"],
        workerSrc: ["'self'", 'blob:'], connectSrc: ["'self'", 'blob:'], formAction: ["'self'"],
        frameAncestors: ["'none'"], upgradeInsecureRequests: secure ? [] : null
      }
    }, crossOriginResourcePolicy: { policy: 'same-origin' }, referrerPolicy: { policy: 'no-referrer' }
  });
  await app.register(rateLimit, { global: false });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: wireBlock }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== origin) throw new ApiError(403, 'ORIGIN_INVALID');
  });
  const options = { httpOnly: true, secure, path: '/' } as const;
  const issueCookie = (reply: FastifyReply, id: string, maxAge: number) =>
    reply.setCookie(sidCookie, id, { ...options, sameSite: 'strict', maxAge });
  const getSession = async (req: FastifyRequest, connected = false): Promise<[string, SiteSession]> => {
    const id = req.cookies[sidCookie] ?? '';
    const session = configured ? await store.get(id) : undefined;
    if (!session || (connected && !session.mtproto)) throw new ApiError(401, 'SESSION_REQUIRED');
    if (connected && /^\/api\/(?:storage\/|telegram\/sessions)/.test(req.url) &&
        req.headers['x-cloudvault-account'] !== session.profile.id) throw new ApiError(409, 'ACCOUNT_CHANGED');
    return [id, session];
  };
  const setup = () => { if (!configured) throw new ApiError(503, 'SETUP_REQUIRED'); };

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ code: 'INVALID_REQUEST' });
    if (error instanceof ApiError) {
      if (error.retryAfter) reply.header('Retry-After', error.retryAfter);
      return reply.code(error.status).send({ code: error.code, retryAfter: error.retryAfter });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) {
      const seconds = Number(reply.getHeader('Retry-After')) || 30;
      return reply.header('Retry-After', seconds).code(429).send({ code: 'RATE_LIMIT', retryAfter: seconds });
    }
    if (status && status >= 400 && status < 500) return reply.code(status).send({ code: 'INVALID_REQUEST' });
    req.log.error({ route: req.routeOptions.url, type: error instanceof Error ? error.name : typeof error }, 'Falha na API CloudVault');
    return reply.code(500).send({ code: 'INTERNAL_ERROR' });
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/session', async (req): Promise<SessionState> => {
    const id = req.cookies[sidCookie] ?? '';
    const session = configured ? await store.get(id) : undefined;
    return { configured, profile: session?.profile, connected: !!session?.mtproto, desktopSetup: desktopRevision };
  });

  if (desktop && desktopRevision) {
    app.post('/api/desktop/setup', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } }, bodyLimit: 4096 }, async (req, reply) => {
      const input = z.object({ token: idString, credentials: desktopCredentials }).strict().parse(req.body);
      if (!equal(input.token, desktop.token)) throw new ApiError(403, 'DESKTOP_SETUP_EXPIRED');
      if (await store.get(req.cookies[sidCookie] ?? '')) throw new ApiError(409, 'DESKTOP_SETUP_CONNECTED');
      await desktop.save(input.credentials);
      reply.raw.once('finish', desktop.reload);
      return reply.code(202).send({ ok: true });
    });
  }

  app.get('/api/auth/start', { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } }, async (req, reply) => {
    if (desktopRevision) return reply.redirect('/');
    setup();
    const existing = req.cookies[sidCookie];
    if (existing && await store.get(existing)) return reply.redirect('/');
    if (authFlows.size >= 400) throw new ApiError(503, 'AUTH_BUSY');
    const key = token();
    const flow = { state: token(), verifier: token(), nonce: token(), expires: Date.now() + 10 * 60_000 };
    authFlows.set(key, flow);
    reply.setCookie(oauthCookie, key, { ...options, sameSite: 'lax', maxAge: 600, path: '/api/auth/callback' });
    return reply.redirect(authorizationUrl(clientId, redirectUri, flow.state, flow.verifier, flow.nonce));
  });

  app.get('/api/auth/callback', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (req, reply) => {
    if (desktopRevision) return reply.redirect('/');
    setup();
    const flowId = req.cookies[oauthCookie] ?? '';
    const flow = authFlows.get(flowId);
    authFlows.delete(flowId);
    reply.clearCookie(oauthCookie, { ...options, sameSite: 'lax', path: '/api/auth/callback' });
    const query = z.object({ code: z.string().max(8192), state: z.string().max(128) }).safeParse(req.query);
    if (!flow || flow.expires <= Date.now() || !query.success || !equal(flow.state, query.data.state)) {
      return reply.redirect('/?auth=expired');
    }
    try {
      const exchange = await fetch(new URL('/token', issuer), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64') },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code: query.data.code, redirect_uri: redirectUri,
          client_id: clientId, code_verifier: flow.verifier
        })
      });
      if (!exchange.ok) return reply.redirect('/?auth=denied');
      const data = z.object({ id_token: z.string() }).parse(await exchange.json());
      const profile = await verifyIdentity(data.id_token, clientId, flow.nonce);
      const id = token();
      await store.save(id, { profile, expires: Date.now() + profileSeconds * 1000 });
      issueCookie(reply, id, profileSeconds);
      return reply.redirect('/');
    } catch { return reply.redirect('/?auth=invalid'); }
  });

  const getQrSession = async (req: FastifyRequest, reply: FastifyReply, start = false): Promise<[string, SiteSession | undefined]> => {
    if (!desktop || !desktopRevision) return getSession(req);
    setup();
    const existing = req.cookies[sidCookie] ?? '';
    const session = await store.get(existing);
    let id = req.cookies[desktopQrCookie];
    if (start) {
      const input = z.object({ token: idString, switchAccount: z.boolean().optional() }).parse(req.body);
      if (!equal(input.token, desktop.token)) throw new ApiError(403, 'DESKTOP_SETUP_EXPIRED');
      if (session?.mtproto && !input.switchAccount) return [existing, session];
      if (id && idString.safeParse(id).success) await telegram.abandon(id);
      id = token();
      reply.setCookie(desktopQrCookie, id, { ...options, sameSite: 'strict', maxAge: 300 });
    }
    if (id && idString.safeParse(id).success) return [id, start ? undefined : await store.get(id)];
    if (session?.mtproto) return [existing, session];
    throw new ApiError(404, 'QR_EXPIRED');
  };
  const qrReply = async (reply: FastifyReply, id: string, session: SiteSession | undefined, state: QrState): Promise<QrResponse> => {
    if (state.stage !== 'connected') return state;
    let profile = session?.profile ?? (await store.get(id))?.profile;
    if (!session?.mtproto) {
      const persisted = await store.get(id);
      if (!persisted?.mtproto) {
        const authorized = await telegram.establish(id, (mtproto, scanned) =>
          store.save(id, { profile: profile ?? scanned, mtproto, expires: Date.now() + sessionSeconds * 1000 }));
        profile ??= authorized;
      } else profile = persisted.profile;
    }
    if (desktopRevision) reply.clearCookie(desktopQrCookie, { ...options, sameSite: 'strict' });
    issueCookie(reply, id, sessionSeconds);
    return { stage: 'connected', session: { configured, connected: true, profile, desktopSetup: desktopRevision } };
  };
  app.post('/api/auth/qr', { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const [id, session] = await getQrSession(req, reply, true);
    if (session?.mtproto) return qrReply(reply, id, session, { stage: 'connected' });
    return qrReply(reply, id, session, await telegram.qr(id, session?.profile, true));
  });
  app.get('/api/auth/qr', { config: { rateLimit: { max: 80, timeWindow: '1 minute' } } }, async (req, reply) => {
    const [id, session] = await getQrSession(req, reply);
    if (session?.mtproto) return qrReply(reply, id, session, { stage: 'connected' });
    if (!(req.query as { wait?: string }).wait) return qrReply(reply, id, session, await telegram.qr(id, session?.profile, false));
    const controller = new AbortController();
    const stop = () => controller.abort();
    reply.raw.once('close', stop);
    try { return await qrReply(reply, id, session, await telegram.waitForQr(id, session?.profile, controller.signal)); }
    finally { reply.raw.removeListener('close', stop); }
  });
  app.post('/api/auth/qr/proof', { config: { rateLimit: { max: 6, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const [id, session] = await getQrSession(req, reply);
    if (session?.mtproto) return qrReply(reply, id, session, { stage: 'connected' });
    return qrReply(reply, id, session, await telegram.prove(id, session?.profile, proof.parse(req.body)));
  });
  const cancelDesktopQr = async (req: FastifyRequest, reply: FastifyReply) => {
    const pending = req.cookies[desktopQrCookie];
    if (pending && idString.safeParse(pending).success) await telegram.abandon(pending);
    reply.clearCookie(desktopQrCookie, { ...options, sameSite: 'strict' });
  };
  if (desktop && desktopRevision) {
    app.post('/api/auth/qr/cancel', async (req, reply) => {
      await cancelDesktopQr(req, reply);
      return { ok: true };
    });
  }
  app.post('/api/auth/logout', async (req, reply) => {
    const id = req.cookies[sidCookie] ?? '';
    const body = z.object({ revoke: z.boolean() }).parse(req.body);
    const session = configured ? await store.get(id) : undefined;
    if (session && req.headers['x-cloudvault-account'] !== session.profile.id) throw new ApiError(409, 'ACCOUNT_CHANGED');
    if (desktopRevision) await cancelDesktopQr(req, reply);
    if (configured && idString.safeParse(id).success) {
      await telegram.close(id, session, body.revoke);
      await store.remove(id);
    }
    reply.clearCookie(sidCookie, { ...options, sameSite: 'strict' });
    return { ok: true };
  });

  app.get('/api/telegram/sessions', async req => telegram.listSessions(...await getSession(req, true)));
  app.get('/api/telegram/photo', async (req, reply) =>
    reply.type('image/jpeg').send(await telegram.profilePhoto(...await getSession(req, true))));
  app.delete('/api/telegram/sessions/:hash', async req => {
    const hash = z.object({ hash: z.string().regex(/^-?\d{1,20}$/) }).parse(req.params).hash;
    await telegram.revokeOther(...await getSession(req, true), hash);
    return { ok: true };
  });
  app.get('/api/storage/limits', async req => ({ maxBytes: await telegram.maxBytes(...await getSession(req, true)) }));
  app.get('/api/storage/journal', async req => {
    const { after, before, known } = z.object({
      after: integer.default(0), before: integer.default(0), known: z.string().regex(/^\d{1,10}(,\d{1,10}){0,99}$/).optional()
    }).parse(req.query);
    return telegram.journal(...await getSession(req, true), after, before, new Set(known?.split(',').map(Number)));
  });
  app.get('/api/storage/header', async req => telegram.getHeader(...await getSession(req, true),
    z.object({ known: integer.default(0) }).parse(req.query).known));
  app.put('/api/storage/header/:id', async req => {
    const s = await getSession(req, true);
    const { id } = z.object({ id: integer.min(1) }).parse(req.params);
    const { next, before } = z.object({ next: header, before: header }).parse(req.body);
    return { id: await telegram.saveHeader(...s, next, before, id) };
  });
  app.post('/api/storage/journal', async req => {
    const session = await getSession(req, true);
    return { id: await telegram.addRecord(...session, journalRecord.parse(req.body)) };
  });
  app.post('/api/storage/upload', async req => {
    const session = await getSession(req, true);
    const { size } = z.object({ size: z.number().int().min(16).max(wireBlock * 8000) }).parse(req.body);
    return { id: await telegram.startUpload(...session, size) };
  });
  app.put('/api/storage/upload/:id/:part', { bodyLimit: wireBlock }, async req => {
    const session = await getSession(req, true);
    const { id, part } = routePart.parse(req.params);
    if (!Buffer.isBuffer(req.body)) throw new ApiError(400, 'CHUNK_INVALID');
    return { next: await telegram.putPart(...session, id, part, req.body) };
  });
  app.post('/api/storage/upload/:id/complete', async req => {
    const session = await getSession(req, true);
    const { id } = z.object({ id: idString }).parse(req.params);
    return { remote: await telegram.completeUpload(...session, id) };
  });
  app.delete('/api/storage/upload/:id', async req => {
    const [owner] = await getSession(req, true);
    telegram.cancelUpload(owner, z.object({ id: idString }).parse(req.params).id);
    return { ok: true };
  });
  app.get('/api/storage/file/:id/:part', async (req, reply) => {
    const session = await getSession(req, true);
    const { id, part } = remotePart.parse(req.params);
    return reply.type('application/octet-stream').send(await telegram.part(...session, id, part));
  });
  app.delete('/api/storage/file/:id', async req => {
    const session = await getSession(req, true);
    const { id } = z.object({ id: integer.min(1) }).parse(req.params);
    await telegram.remove(...session, id);
    return { ok: true };
  });

  const web = resolve('dist/web');
  if (existsSync(web)) {
    await app.register(fastifyStatic, { root: web, prefix: '/', decorateReply: true });
    if (desktopRevision) {
      app.get('/api/desktop/open', (_req, reply) => reply.sendFile('index.html', { cacheControl: false }));
    }
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && req.headers.accept?.includes('text/html')) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ code: 'NOT_FOUND' });
    });
  }

  const timer = setInterval(() => {
    for (const [id, flow] of authFlows) if (flow.expires <= Date.now()) authFlows.delete(id);
    void Promise.all([telegram.sweep(), store.sweep()]).catch(() => app.log.warn('Falha na limpeza de sessões'));
  }, 60_000).unref();
  app.addHook('onClose', async () => { clearInterval(timer); });
  return app;
}
