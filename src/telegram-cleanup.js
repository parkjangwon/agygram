export const MAX_TRACKED_TELEGRAM_MESSAGES = 120;

// Telegram generally allows bot-side deletion for messages younger than 48h.
// Keep a small safety margin so /clear skips predictable API failures.
export const TELEGRAM_DELETE_WINDOW_MS = 47.5 * 60 * 60 * 1_000;

function safeMessageId(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function safeIsoDate(value) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  return new Date().toISOString();
}

export function normalizeTrackedTelegramMessages(messages = [], additions = [], {
  max = MAX_TRACKED_TELEGRAM_MESSAGES,
} = {}) {
  const combined = [
    ...(Array.isArray(messages) ? messages : []),
    ...(Array.isArray(additions) ? additions : []),
  ];
  const byId = new Map();

  for (const item of combined) {
    const messageId = safeMessageId(item?.messageId ?? item?.id);
    if (messageId == null) continue;
    byId.set(messageId, {
      messageId,
      direction: item?.direction === 'in' ? 'in' : 'out',
      at: safeIsoDate(item?.at),
    });
  }

  return [...byId.values()].slice(-Math.max(1, max));
}

export function extractTelegramMessageIds(result) {
  if (Array.isArray(result)) {
    return result
      .map((item) => safeMessageId(item?.message_id ?? item?.messageId))
      .filter((messageId) => messageId != null);
  }
  const messageId = safeMessageId(result?.message_id ?? result?.messageId);
  return messageId == null ? [] : [messageId];
}

function isInsideDeleteWindow(entry, nowMs, deleteWindowMs) {
  const sentAt = Date.parse(entry.at);
  return !Number.isFinite(sentAt) || nowMs - sentAt <= deleteWindowMs;
}

export async function deleteTrackedTelegramMessages({
  telegram,
  chatId,
  messages,
  extraMessageIds = [],
  nowMs = Date.now(),
  deleteWindowMs = TELEGRAM_DELETE_WINDOW_MS,
}) {
  if (!telegram || typeof telegram.callApi !== 'function') {
    throw new TypeError('telegram.callApi is required');
  }

  const extras = extraMessageIds.map((messageId) => ({
    messageId,
    direction: 'in',
    at: new Date(nowMs).toISOString(),
  }));
  const normalized = normalizeTrackedTelegramMessages(messages);
  const skipped = normalized.filter((entry) => !isInsideDeleteWindow(entry, nowMs, deleteWindowMs)).length;
  const candidates = normalizeTrackedTelegramMessages(normalized, extras)
    .filter((entry) => isInsideDeleteWindow(entry, nowMs, deleteWindowMs));
  const ids = [...new Set(candidates.map((entry) => entry.messageId))].reverse();
  const result = {
    attempted: ids.length,
    deleted: 0,
    failed: 0,
    skipped,
  };

  for (const messageId of ids) {
    try {
      await telegram.callApi('deleteMessage', {
        chat_id: chatId,
        message_id: messageId,
      });
      result.deleted += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}
