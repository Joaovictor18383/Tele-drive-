import { header, type Envelope, type Header } from '../../shared/protocol';
import { argon2id } from 'hash-wasm';

export const bytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const utf8 = new TextEncoder();
const unicode = new TextDecoder('utf-8', { fatal: true });
export const to64 = (data: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < data.length; i += 0x4000) binary += String.fromCharCode(...data.subarray(i, i + 0x4000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
export const from64 = (text: string) =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export const aes = (raw: Uint8Array<ArrayBuffer>) =>
  crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
export const seal = async (key: CryptoKey, plaintext: Uint8Array<ArrayBuffer>, context: string): Promise<Envelope> => {
  const iv = bytes(12);
  const result = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(context) }, key, plaintext);
  return { iv: to64(iv), data: to64(new Uint8Array(result)) };
};
export const open = async (key: CryptoKey, value: Envelope, context: string) =>
  new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: from64(value.iv), additionalData: utf8.encode(context) }, key, from64(value.data)
  ));
export const sealJson = (key: CryptoKey, value: unknown, context: string) =>
  seal(key, utf8.encode(JSON.stringify(value)), context);
export const openJson = async (key: CryptoKey, value: Envelope, context: string): Promise<unknown> =>
  JSON.parse(unicode.decode(await open(key, value, context)));

async function passwordKey(password: string, salt: Uint8Array<ArrayBuffer>) {
  const raw = await argon2id({
    password, salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: 'binary'
  });
  try { return await aes(new Uint8Array(raw)); }
  finally { raw.fill(0); }
}

export async function wrapPassword(raw: Uint8Array<ArrayBuffer>, vault: string, password: string) {
  const salt = bytes(16);
  return { salt: to64(salt), password: await seal(await passwordKey(password, salt), raw, 'cv1/password/' + vault) };
}

export async function createVault(password: string) {
  const raw = bytes(32);
  const recoveryRaw = bytes(32);
  const vault = crypto.randomUUID();
  try {
    return {
      raw: to64(raw), recoveryCode: 'CV1-' + to64(recoveryRaw),
      header: {
        version: 1 as const, vault, ...await wrapPassword(raw, vault, password),
        recovery: await seal(await aes(recoveryRaw), raw, 'cv1/recovery/' + vault)
      }
    };
  } finally { raw.fill(0); recoveryRaw.fill(0); }
}

export async function unlockVault(value: Header, secret: string, recover: boolean) {
  const h = header.parse(value);
  const code = secret.trim();
  if (recover && !/^CV1-[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('RECOVERY_INVALID');
  const raw = await (recover
    ? open(await aes(from64(code.slice(4))), h.recovery, 'cv1/recovery/' + h.vault)
    : open(await passwordKey(secret, from64(h.salt)), h.password, 'cv1/password/' + h.vault));
  try { return to64(raw); }
  finally { raw.fill(0); }
}

export async function newRecovery(raw: Uint8Array<ArrayBuffer>, vault: string) {
  const recoveryRaw = bytes(32);
  try {
    return {
      recovery: await seal(await aes(recoveryRaw), raw, 'cv1/recovery/' + vault),
      recoveryCode: 'CV1-' + to64(recoveryRaw)
    };
  } finally { recoveryRaw.fill(0); }
}

export function fileContext(prefix: Uint8Array<ArrayBuffer>, id: string, part: number, size: number) {
  if (prefix.length !== 8 || !Number.isInteger(part) || part < 0 || part > 0xffffffff) throw new Error('CHUNK_INVALID');
  const iv = new Uint8Array(12);
  iv.set(prefix);
  new DataView(iv.buffer).setUint32(8, part);
  return { name: 'AES-GCM', iv, additionalData: utf8.encode(`cv1/file/${id}/${part}/${size}`) };
}

export const encryptBlock = (key: CryptoKey, prefix: Uint8Array<ArrayBuffer>, id: string, part: number, size: number, data: ArrayBuffer) =>
  crypto.subtle.encrypt(fileContext(prefix, id, part, size), key, data);
export const decryptBlock = (key: CryptoKey, prefix: Uint8Array<ArrayBuffer>, id: string, part: number, size: number, data: ArrayBuffer) =>
  crypto.subtle.decrypt(fileContext(prefix, id, part, size), key, data);
