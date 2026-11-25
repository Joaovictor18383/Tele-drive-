import { mkdir, readFile, rename, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Profile } from '../shared/protocol';
import { sessionCipher, token } from './security';

export const sessionSeconds = 60 * 60 * 24 * 30;
export const profileSeconds = 60 * 15;
export const validSessionId = (id: string) => /^[A-Za-z0-9_-]{43}$/.test(id);

export type SiteSession = { profile: Profile; expires: number; mtproto?: string };

export class Sessions {
  private readonly cipher;
  private readonly dir;
  private readonly temporary = new Map<string, SiteSession>();

  constructor(key: Buffer, dir: string) {
    this.cipher = sessionCipher(key);
    this.dir = resolve(dir);
  }

  async get(id: string) {
    if (!validSessionId(id)) return;
    let data = this.temporary.get(id);
    if (!data) {
      try { data = this.cipher.decrypt<SiteSession>(await readFile(join(this.dir, id)), id); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    }
    if (data.expires <= Date.now()) {
      await this.remove(id);
      return;
    }
    return data;
  }

  async save(id: string, data: SiteSession) {
    if (!validSessionId(id)) throw new Error('SESSION_ID_INVALID');
    if (!data.mtproto) {
      this.temporary.set(id, data);
      return;
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, id);
    const temp = join(this.dir, token() + '.tmp');
    try {
      await writeFile(temp, this.cipher.encrypt(data, id), { flag: 'wx', mode: 0o600 });
      await rename(temp, path);
      this.temporary.delete(id);
    } finally { await rm(temp, { force: true }); }
  }

  async remove(id: string) {
    if (!validSessionId(id)) return;
    this.temporary.delete(id);
    await rm(join(this.dir, id), { force: true });
  }

  async sweep() {
    const now = Date.now();
    for (const [id, s] of this.temporary) if (s.expires <= now) this.temporary.delete(id);
    let names: string[];
    try { names = await readdir(this.dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of names) {
      if (!validSessionId(name) && !/^[A-Za-z0-9_-]{43}\.tmp$/.test(name)) continue;
      const path = join(this.dir, name);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) continue;
      const age = validSessionId(name) ? sessionSeconds * 1000 : 60 * 60_000;
      if (now - info.mtimeMs > age) await rm(path, { force: true });
    }
  }
}
