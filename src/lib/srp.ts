import { sha256 } from '@noble/hashes/sha2.js';
import type { SrpChallenge } from '../../shared/auth';
import { bytes, from64, to64 } from './crypto';

// Telegram's published 2048-bit safe prime. Unknown groups are rejected.
const knownPrime = 'c71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c3720fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f642477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a4a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae4e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851f0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b';
const hex = (input: Uint8Array) => Array.from(input, v => v.toString(16).padStart(2, '0')).join('');
const number = (input: Uint8Array) => BigInt('0x' + hex(input));
const padded = (input: bigint) => Uint8Array.from(input.toString(16).padStart(512, '0').match(/../g)!, x => parseInt(x, 16));
const join = (...inputs: Uint8Array[]) => {
  const array = new Uint8Array(inputs.reduce((sum, input) => sum + input.length, 0));
  let cursor = 0;
  for (const input of inputs) { array.set(input, cursor); cursor += input.length; }
  return array;
};
const h = (...inputs: Uint8Array[]) => sha256(join(...inputs));
const sh = (input: Uint8Array, salt: Uint8Array) => h(salt, input, salt);

function power(base: bigint, exponent: bigint, modulus: bigint) {
  let v = 1n;
  while (exponent > 0n) {
    if (exponent & 1n) v = v * base % modulus;
    base = base * base % modulus;
    exponent >>= 1n;
  }
  return v;
}

export async function telegramProof(challenge: SrpChallenge, password: string) {
  const pBytes = from64(challenge.p);
  if (hex(pBytes) !== knownPrime || ![3, 4, 5, 7].includes(challenge.g)) throw new Error('TELEGRAM_2FA_UNSUPPORTED');
  const p = number(pBytes), g = BigInt(challenge.g), B = number(from64(challenge.b));
  const min = 1n << 1984n;
  const good = (n: bigint) => n >= min && p - n >= min;
  if (!good(B)) throw new Error('TELEGRAM_2FA_UNSUPPORTED');

  const s1 = from64(challenge.salt1), s2 = from64(challenge.salt2), ng = padded(g), nB = padded(B);
  const pw = new TextEncoder().encode(password);
  const ph = sh(sh(pw, s1), s2);
  pw.fill(0);
  const imported = await crypto.subtle.importKey('raw', new Uint8Array(ph), 'PBKDF2', false, ['deriveBits']);
  ph.fill(0);
  const digest = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt: s1, iterations: 100000 }, imported, 512));
  const x = number(sh(digest, s2));
  digest.fill(0);
  const k = number(h(pBytes, ng));
  const t = ((B - k * power(g, x, p)) % p + p) % p;
  if (!good(t)) throw new Error('TELEGRAM_2FA_UNSUPPORTED');

  let a: bigint;
  let A: bigint;
  let u: bigint;
  do {
    const entropy = bytes(256);
    a = number(entropy);
    entropy.fill(0);
    A = power(g, a, p);
    u = number(h(padded(A), nB));
  } while (!good(A) || !u);
  const ns = h(padded(power(t, a + u * x, p)));
  const hp = h(pBytes);
  const hg = h(ng);
  const xor = hp.map((v, index) => v ^ hg[index]);
  return { id: challenge.id, a: to64(padded(A)), m1: to64(h(xor, h(s1), h(s2), padded(A), nB, ns)) };
}
