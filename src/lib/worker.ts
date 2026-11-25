import { sha256 } from '@noble/hashes/sha2.js';
import { aes, createVault, decryptBlock, encryptBlock, from64, newRecovery, unlockVault, wrapPassword } from './crypto';
import { telegramProof } from './srp';
import type { Header } from '../../shared/protocol';
import type { SrpChallenge } from '../../shared/auth';

const hashers = new Map<string, ReturnType<typeof sha256.create>>();
const keys = new Map<string, CryptoKey>();

const handlers = {
  create: (password: string) => createVault(password),
  unlock: (h: Header, secret: string, recover: boolean) => unlockVault(h, secret, recover),
  wrap: (raw: string, vault: string, password: string) => wrapPassword(from64(raw), vault, password),
  recovery: (raw: string, vault: string) => newRecovery(from64(raw), vault),
  srp: (challenge: SrpChallenge, password: string) => telegramProof(challenge, password),
  hashStart: (id: string) => { hashers.set(id, sha256.create()); },
  hashPart: (id: string, data: ArrayBuffer) => { hashers.get(id)!.update(new Uint8Array(data)); },
  hashEnd: (id: string) => {
    const result = hashers.get(id)!.digest();
    hashers.delete(id);
    return Array.from(result, byte => byte.toString(16).padStart(2, '0')).join('');
  },
  fileOpen: async (id: string, raw: string) => { keys.set(id, await aes(from64(raw))); },
  fileClose: (id: string) => { keys.delete(id); hashers.delete(id); },
  encrypt: (job: string, nonce: string, id: string, part: number, size: number, data: ArrayBuffer) =>
    encryptBlock(keys.get(job)!, from64(nonce), id, part, size, data),
  decrypt: (job: string, nonce: string, id: string, part: number, size: number, data: ArrayBuffer) =>
    decryptBlock(keys.get(job)!, from64(nonce), id, part, size, data)
};

export type Commands = typeof handlers;
const scope = self as unknown as { onmessage: (event: MessageEvent) => void; postMessage: (data: unknown, transfer?: Transferable[]) => void };
scope.onmessage = async event => {
  const { id, method, args } = event.data as { id: number; method: keyof Commands; args: never[] };
  try {
    const handler = handlers[method] as (...a: never[]) => unknown;
    const value = await handler(...args);
    scope.postMessage({ id, value }, value instanceof ArrayBuffer ? [value] : []);
  } catch (e) { scope.postMessage({ id, error: e instanceof Error ? e.message : 'CRYPTO_FAILED' }); }
};
