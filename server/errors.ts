export class ApiError extends Error {
  constructor(public status: number, public code: string, public retryAfter?: number) { super(code); }
}
export const errorCode = (error: unknown) => {
  const e = error as { errorMessage?: string; message?: string };
  return e?.errorMessage ?? e?.message ?? '';
};

export function translateTelegramError(error: unknown) {
  if (error instanceof ApiError) return error;
  const text = errorCode(error);
  const wait = text.match(/FLOOD_(?:PREMIUM_)?WAIT(?:_PREMIUM)?_(\d+)/i);
  const seconds = (error as { seconds?: number } | null)?.seconds;
  if (wait || (seconds && /FLOOD/i.test(text))) {
    return new ApiError(429, /PREMIUM/i.test(text) ? 'TELEGRAM_PREMIUM_WAIT' : 'TELEGRAM_WAIT', Math.max(1, Number(wait?.[1] ?? seconds)));
  }
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|AUTH_KEY_DUPLICATED|USER_DEACTIVATED/.test(text)) return new ApiError(401, 'SESSION_REVOKED');
  if (/FILE_PART_\d+_MISSING|FILE_PARTS_INVALID/.test(text)) return new ApiError(409, 'UPLOAD_EXPIRED');
  if (/PASSWORD_HASH_INVALID|SRP_ID_INVALID/.test(text)) return new ApiError(400, 'TELEGRAM_2FA_INVALID');
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(text)) return new ApiError(400, 'TELEGRAM_API_INVALID');
  if (/FRESH_RESET_AUTHORISATION_FORBIDDEN/.test(text)) return new ApiError(409, 'TELEGRAM_RECENT_SESSION');
  return new ApiError(502, 'TELEGRAM_UNAVAILABLE');
}
