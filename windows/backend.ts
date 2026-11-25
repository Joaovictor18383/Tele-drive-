import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp, type DesktopCredentials } from '../server/app';
import { ApiError } from '../server/errors';

const [settings, data, mode] = process.argv.slice(2);
const testing = mode === 'self-test';
const envFile = join(settings, '.env');
if (!testing && existsSync(envFile)) process.loadEnvFile(envFile);
const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development', SESSION_DIR: join(data, 'sessions') };
const configuration = join(data, 'telegram-config.json');
type Saved = { credentials: DesktopCredentials; key: string; origin: string };
let saved: Saved | undefined;
try { saved = JSON.parse(await readFile(configuration, 'utf8')) as Saved; }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const setupToken = randomBytes(32).toString('base64url');
const origin = saved?.origin ?? (!testing && process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:5173');
const url = new URL(origin);
if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || !url.port) {
  throw new Error('PUBLIC_ORIGIN precisa indicar um endereço HTTP local com porta.');
}
const host = '127.0.0.1';
async function availablePort(preferred: number): Promise<number> {
  const probe = createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', error => preferred && (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? void availablePort(0).then(resolve, reject)
      : reject(error));
    probe.listen(preferred, host, () => {
      const addr = probe.address();
      probe.close(error => error ? reject(error) : resolve(typeof addr === 'object' && addr ? addr.port : preferred));
    });
  });
}
const fixed = !!saved || (!testing && !!process.env.PUBLIC_ORIGIN);
const port = fixed ? Number(url.port) : await availablePort(testing ? 0 : Number(url.port));
url.port = String(port);
let app: Awaited<ReturnType<typeof createApp>>;
let closing = false;
let restarting = false;

async function start() {
  const configured = saved ? {
    TELEGRAM_API_ID: saved.credentials.apiId, TELEGRAM_API_HASH: saved.credentials.apiHash, SESSION_KEY: saved.key
  } : {};
  app = await createApp({ ...env, ...configured, PUBLIC_ORIGIN: url.origin }, {
    token: setupToken,
    async save(credentials) {
      if (closing || restarting) throw new ApiError(409, 'DESKTOP_SETUP_BUSY');
      restarting = true;
      const key = saved?.key ?? (/^[a-f0-9]{64}$/i.test(env.SESSION_KEY ?? '') ? env.SESSION_KEY! : randomBytes(32).toString('hex'));
      const next: Saved = { credentials, key, origin: url.origin };
      const temp = configuration + '.' + randomBytes(10).toString('hex') + '.tmp';
      try {
        await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
        await rename(temp, configuration);
        saved = next;
      } catch (error) {
        restarting = false;
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    reload() {
      setTimeout(() => void restart().catch(() => process.exit(1)), 80);
    }
  });
  await app.listen({ port, host });
}
async function restart() {
  if (closing) return;
  await app.close();
  if (closing) return;
  await start();
  restarting = false;
}
await start();
const input = createInterface({ input: process.stdin });
const close = () => {
  closing = true;
  void app.close().finally(() => process.exit(0));
};
input.once('close', close);
process.once('SIGTERM', close);
process.stdout.write('CLOUDVAULT_READY ' + url.origin + '/api/desktop/open#setup=' + setupToken + '\n');
