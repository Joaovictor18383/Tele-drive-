import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkCount, cipherSize, plainBlock, wireBlock } from '../shared/protocol';
import { aes, bytes, createVault, decryptBlock, encryptBlock, from64, newRecovery, openJson, sealJson, unlockVault, wrapPassword } from '../src/lib/crypto';

test('on-device master password and recovery key unlock the same random vault key', async () => {
  const password = 'Uma frase longa para testar Argon2id';
  const { header, raw, recoveryCode } = await createVault(password);
  assert.equal(await unlockVault(header, password, false), raw);
  assert.equal(await unlockVault(header, recoveryCode, true), raw);
  await assert.rejects(unlockVault(header, 'senha incorreta', false));
  await assert.rejects(unlockVault(header, 'CV1-' + 'x'.repeat(43), true));
  const wrap = await wrapPassword(from64(raw), header.vault, 'Uma outra frase longa');
  const recovery = await newRecovery(from64(raw), header.vault);
  const rotated = { ...header, ...wrap, recovery: recovery.recovery };
  assert.equal(await unlockVault(rotated, 'Uma outra frase longa', false), raw);
  assert.equal(await unlockVault(rotated, recovery.recoveryCode, true), raw);
  await assert.rejects(unlockVault(rotated, password, false));
  await assert.rejects(unlockVault(rotated, recoveryCode, true));
});

test('encrypted index authenticates metadata and its vault context', async () => {
  const key = await aes(bytes(32));
  const value = { name: 'pasta-sensível', children: ['folha-salarial.pdf'] };
  const cipher = await sealJson(key, value, 'cv1/op/test-vault');
  assert.equal(JSON.stringify(cipher).includes(value.name), false);
  assert.deepEqual(await openJson(key, cipher, 'cv1/op/test-vault'), value);
  await assert.rejects(openJson(key, cipher, 'cv1/op/other-vault'));
});

test('AES-GCM authenticates data, order, file identity, and expected final length', async () => {
  const key = await aes(bytes(32));
  const otherKey = await aes(bytes(32));
  const nonce = bytes(8);
  const id = crypto.randomUUID();
  const input = bytes(1000);
  const ciphertext = await encryptBlock(key, nonce, id, 0, input.byteLength, input.buffer);
  assert.deepEqual(new Uint8Array(await decryptBlock(key, nonce, id, 0, input.byteLength, ciphertext)), input);
  await assert.rejects(decryptBlock(otherKey, nonce, id, 0, input.byteLength, ciphertext));
  await assert.rejects(decryptBlock(key, nonce, id, 1, input.byteLength, ciphertext));
  await assert.rejects(decryptBlock(key, nonce, crypto.randomUUID(), 0, input.byteLength, ciphertext));
  await assert.rejects(decryptBlock(key, nonce, id, 0, input.byteLength + 1, ciphertext));
  new Uint8Array(ciphertext)[0] ^= 0x01;
  await assert.rejects(decryptBlock(key, nonce, id, 0, input.byteLength, ciphertext));
  assert.equal(chunkCount(0), 1);
  assert.equal(cipherSize(0), 16);
  assert.equal(cipherSize(plainBlock), wireBlock);
  assert.equal(cipherSize(plainBlock + 1), wireBlock + 17);
});
