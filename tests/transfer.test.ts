import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import bigInt from 'big-integer';
import { Api, type TelegramClient } from 'telegram';
import { Telegram } from '../server/telegram';
import { translateTelegramError } from '../server/errors';
import { limitParts, wireBlock } from '../shared/protocol';
import type { SiteSession } from '../server/sessions';

class TransportFixture extends Telegram {
  requests: unknown[] = [];
  removals: number[] = [];
  source?: Api.Message;
  premium = false;
  flood = false;
  protected override makeClient() {
    const client = {
      connect: async () => true,
      destroy: async () => undefined,
      getMe: async () => new Api.User({ id: bigInt(76), premium: this.premium }),
      getMessages: async () => [this.source],
      deleteMessages: async (_peer: unknown, ids: number[]) => { this.removals.push(...ids); },
      iterDownload: async function* ({ offset }: { offset: bigInt.BigInteger }) {
        yield Buffer.alloc(offset.eq(0) ? wireBlock : 16, 0x41);
      },
      invoke: async (request: unknown) => {
        this.requests.push(request);
        if (request instanceof Api.help.GetAppConfig) {
          return new Api.help.AppConfig({ hash: 1, config: new Api.JsonObject({ value: [
            new Api.JsonObjectValue({ key: 'upload_max_fileparts_default', value: new Api.JsonNumber({ value: 3800 }) }),
            new Api.JsonObjectValue({ key: 'upload_max_fileparts_premium', value: new Api.JsonNumber({ value: 7900 }) })
          ] }) });
        }
        if (request instanceof Api.upload.SaveFilePart || request instanceof Api.upload.SaveBigFilePart) {
          if (this.flood) throw { errorMessage: 'FLOOD_WAIT_120', seconds: 120 };
          return true;
        }
        if (request instanceof Api.messages.SendMedia) return new Api.UpdateShortSentMessage({ id: 881, pts: 1, ptsCount: 1, date: 100 });
        throw new Error('Unexpected Telegram request in test');
      }
    };
    return client as unknown as TelegramClient;
  }
}
const account: SiteSession = { profile: { id: '76', name: 'Fixture' }, expires: 100, mtproto: 'session-fixture' };

test('uploads bounded MTProto parts in sequence, supports replay, and commits exactly once', async () => {
  const transport = new TransportFixture(100, 'fixture-key');
  assert.equal(await transport.maxBytes('owner', account), 3800 * wireBlock);
  const size = wireBlock + 53;
  const id = await transport.startUpload('owner', account, size);
  const first = Buffer.alloc(wireBlock, 0x41);
  await assert.rejects(transport.putPart('other', account, id, 0, first), /UPLOAD_EXPIRED/);
  await assert.rejects(transport.putPart('owner', account, id, 1, Buffer.alloc(53)), /CHUNK_INVALID/);
  await assert.rejects(transport.completeUpload('owner', account, id), /UPLOAD_INCOMPLETE/);
  assert.equal(await transport.putPart('owner', account, id, 0, first), 1);
  assert.equal(await transport.putPart('owner', account, id, 0, first), 1);
  await assert.rejects(transport.putPart('owner', account, id, 0, Buffer.alloc(wireBlock)), /CHUNK_INVALID/);
  assert.equal(await transport.putPart('owner', account, id, 1, Buffer.alloc(53)), 2);
  assert.equal(await transport.completeUpload('owner', account, id), 881);
  assert.equal(await transport.completeUpload('owner', account, id), 881);
  assert.equal(transport.requests.filter(r => r instanceof Api.upload.SaveFilePart).length, 2);
  const sent = transport.requests.filter(r => r instanceof Api.messages.SendMedia);
  assert.equal(sent.length, 1);
  assert(sent[0].peer instanceof Api.InputPeerSelf);
  assert(sent[0].media instanceof Api.InputMediaUploadedDocument);
  assert(sent[0].media.file instanceof Api.InputFile);
  assert.match(sent[0].media.file.name, /^[a-f0-9]{32}\.enc$/);
});

test('Telegram Premium limits and FLOOD_WAIT replies are respected', async () => {
  const transport = new TransportFixture(100, 'fixture-key');
  transport.premium = true;
  assert.equal(await transport.maxBytes('premium', account), 7900 * wireBlock);
  assert.equal(limitParts(99999, false), 4000);
  assert.equal(limitParts(0, true), 8000);
  await assert.rejects(transport.startUpload('premium', account, 7900 * wireBlock + 1), /FILE_TOO_LARGE/);
  const id = await transport.startUpload('premium', account, 16);
  transport.flood = true;
  await assert.rejects(transport.putPart('premium', account, id, 0, Buffer.alloc(16)),
    e => (e as { status: number; retryAfter: number }).status === 429 && (e as { retryAfter: number }).retryAfter === 120);
  const prior = transport.requests.length;
  transport.flood = false;
  await assert.rejects(transport.putPart('premium', account, id, 0, Buffer.alloc(16)), /TELEGRAM_WAIT/);
  assert.equal(transport.requests.length, prior);
  assert.equal(translateTelegramError({ errorMessage: 'FLOOD_PREMIUM_WAIT_3' }).code, 'TELEGRAM_PREMIUM_WAIT');
});

test('reads and removes only the account’s signed CloudVault documents', async () => {
  const fixture = new TransportFixture(100, 'fixture-key');
  const fileName = 'a'.repeat(32) + '.enc';
  const document = new Api.Document({
    id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.alloc(0), date: 1,
    mimeType: 'application/octet-stream', size: bigInt(wireBlock + 16), dcId: 2,
    attributes: [new Api.DocumentAttributeFilename({ fileName })]
  });
  const signed = 'CloudVaultFileV1 ' + createHmac('sha256', 'fixture-key')
    .update('CloudVaultFileV1/76/' + fileName).digest('hex');
  const telegramMessage = (peer: number, caption: string) => new Api.Message({
    id: 9, peerId: new Api.PeerUser({ userId: bigInt(peer) }), date: 1, message: caption,
    media: new Api.MessageMediaDocument({ document })
  });
  fixture.source = telegramMessage(76, 'Documento pessoal');
  await assert.rejects(fixture.part('owner', account, 9, 0), /FILE_UNAVAILABLE/);
  await fixture.remove('owner', account, 9);
  fixture.source = telegramMessage(77, signed);
  await assert.rejects(fixture.part('owner', account, 9, 0), /FILE_UNAVAILABLE/);
  await fixture.remove('owner', account, 9);
  assert.deepEqual(fixture.removals, []);
  fixture.source = telegramMessage(76, signed);
  assert.equal((await fixture.part('owner', account, 9, 0)).length, wireBlock);
  assert.equal((await fixture.part('owner', account, 9, 1)).length, 16);
  await assert.rejects(fixture.part('owner', account, 9, 2), /CHUNK_INVALID/);
  await fixture.remove('owner', account, 9);
  assert.deepEqual(fixture.removals, [9]);
});
