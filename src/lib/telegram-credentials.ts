export type TelegramFields = { apiId: string; apiHash: string };
export const validTelegramId = (value: string) => /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647;
export const validTelegramHash = (value: string) => /^[a-f0-9]{32}$/i.test(value);

const labels = {
  apiId: /\b(?:telegram[ _-]+)?api[ _-]+id["']?\s*(?:[:=]\s*)?["']?(\d{1,10})(?!\w)/gi,
  apiHash: /\b(?:telegram[ _-]+)?api[ _-]+hash["']?\s*(?:[:=]\s*)?["']?([a-f0-9]{32})(?!\w)/gi
};
const findValues = (text: string, field: keyof TelegramFields) =>
  [...new Set(Array.from(text.matchAll(labels[field]), match => match[1]))];

export function telegramCredentials(apiId: string, apiHash: string) {
  const id = apiId.trim();
  const hash = apiHash.trim();
  return validTelegramId(id) && validTelegramHash(hash) ? { apiId: id, apiHash: hash } : undefined;
}

export function parseTelegramCredentials(clipboard: string) {
  const text = clipboard.trim();
  if (!text || text.length > 64_000) return;
  const tokens = text.split(/\s+/);
  if (tokens.length === 2) {
    const barePair = telegramCredentials(tokens[0], tokens[1]) ?? telegramCredentials(tokens[1], tokens[0]);
    if (barePair) return barePair;
  }

  const ids = findValues(text, 'apiId');
  const hashes = findValues(text, 'apiHash');
  if (ids.length !== 1 || hashes.length !== 1) return;
  return telegramCredentials(ids[0], hashes[0]);
}

export function pasteTelegramField(clipboard: string): { field: keyof TelegramFields; value: string } | undefined {
  const text = clipboard.trim();
  if (!text || text.length > 512) return;
  const ids = findValues(text, 'apiId');
  const hashes = findValues(text, 'apiHash');
  if (ids.length + hashes.length > 1) return;
  const id = ids[0] ?? text;
  const hash = hashes[0] ?? text;
  if (validTelegramId(id)) return { field: 'apiId', value: id };
  if (validTelegramHash(hash)) return { field: 'apiHash', value: hash };
}
