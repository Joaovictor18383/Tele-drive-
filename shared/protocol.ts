import { z } from 'zod';

export const wireBlock = 512 * 1024;
export const plainBlock = wireBlock - 16;
export const smallUpload = 10 * 1024 * 1024;
export const indexLimit = 1024 * 1024;

export const chunkCount = (size: number) => Math.max(1, Math.ceil(size / plainBlock));
export const cipherSize = (size: number) => size + 16 * chunkCount(size);
export const wireLength = (size: number, part: number) => Math.min(wireBlock, size - part * wireBlock);
export const limitParts = (value: number, premium: boolean) =>
  Number.isSafeInteger(value) && value > 0 ? Math.min(value, premium ? 8000 : 4000) : premium ? 8000 : 4000;

export const uuid = z.uuid();
const encoded = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const envelope = z.object({ iv: encoded.length(16), data: encoded });
const wrappedKey = envelope.extend({ data: encoded.length(64) });
export const header = z.object({
  version: z.literal(1), vault: uuid, salt: encoded.length(22),
  password: wrappedKey, recovery: wrappedKey
});
export type Header = z.infer<typeof header>;
export type Envelope = z.infer<typeof envelope>;
export const folderColors = ['slate', 'blue', 'violet', 'amber', 'green', 'rose'] as const;
export const itemName = z.string().trim().min(1).max(240).refine(s => !/[\\/\x00-\x1f]/.test(s) && s !== '.' && s !== '..');
const base = z.object({
  id: uuid, name: itemName, parent: uuid.nullable(),
  created: z.number().int().nonnegative(), updated: z.number().int().nonnegative(),
  favorite: z.boolean(), trash: z.number().int().positive().nullable()
});
export const entry = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('folder'), color: z.enum(folderColors) }),
  base.extend({
    kind: z.literal('file'), size: z.number().int().nonnegative(), mime: z.string().max(200),
    remote: z.number().int().positive(), key: encoded.length(43), nonce: encoded.length(11),
    contentId: uuid, hash: z.string().regex(/^[a-f0-9]{64}$/)
  })
]);
export type Entry = z.infer<typeof entry>;
export type FileEntry = Extract<Entry, { kind: 'file' }>;
export type Folder = Extract<Entry, { kind: 'folder' }>;
export type Color = Folder['color'];

export const change = z.discriminatedUnion('type', [
  z.object({ type: z.literal('put'), entry }),
  z.object({ type: z.literal('edit'), id: uuid, patch: base.pick({ name: true, parent: true, favorite: true, trash: true }).partial().extend({
    color: z.enum(folderColors).optional(), updated: z.number().int().nonnegative()
  }) }),
  z.object({ type: z.literal('remove'), id: uuid })
]);
export const operation = z.object({ changes: z.array(change).min(1).max(100) });
export type Change = z.infer<typeof change>;
export const journalRecord = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('header'), value: header }),
  z.object({ kind: z.literal('op'), vault: uuid, value: envelope })
]);
export type JournalRecord = z.infer<typeof journalRecord>;
export type RemoteRecord = { id: number; record: JournalRecord };
export type Profile = { id: string; name: string; username?: string; picture?: string };
export type SessionState = { configured: boolean; profile?: Profile; connected: boolean; maxBytes?: number; desktopSetup?: string };
