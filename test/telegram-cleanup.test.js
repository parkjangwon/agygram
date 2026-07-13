import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deleteTrackedTelegramMessages,
  extractTelegramMessageIds,
  normalizeTrackedTelegramMessages,
} from '../src/telegram-cleanup.js';

test('extractTelegramMessageIds supports single and media-group responses', () => {
  assert.deepEqual(extractTelegramMessageIds({ message_id: 10 }), [10]);
  assert.deepEqual(extractTelegramMessageIds([{ message_id: 11 }, { message_id: 12 }]), [11, 12]);
  assert.deepEqual(extractTelegramMessageIds({}), []);
});

test('normalizeTrackedTelegramMessages deduplicates and caps recent message IDs', () => {
  const normalized = normalizeTrackedTelegramMessages(
    [{ messageId: 1, direction: 'in', at: '2026-07-13T00:00:00.000Z' }],
    [
      { messageId: 1, direction: 'out', at: '2026-07-13T00:01:00.000Z' },
      { id: 2, direction: 'in', at: '2026-07-13T00:02:00.000Z' },
      { messageId: 'bad' },
    ],
    { max: 2 },
  );

  assert.deepEqual(normalized.map((entry) => entry.messageId), [1, 2]);
  assert.equal(normalized[0].direction, 'out');
});

test('deleteTrackedTelegramMessages deletes recent messages and skips old records', async () => {
  const calls = [];
  const nowMs = Date.parse('2026-07-13T12:00:00.000Z');
  const telegram = {
    async callApi(method, payload) {
      calls.push({ method, payload });
      if (payload.message_id === 3) throw new Error('not found');
      return true;
    },
  };

  const result = await deleteTrackedTelegramMessages({
    telegram,
    chatId: 42,
    nowMs,
    deleteWindowMs: 60_000,
    messages: [
      { messageId: 1, at: '2026-07-13T11:58:00.000Z' },
      { messageId: 2, at: '2026-07-13T11:59:30.000Z' },
      { messageId: 3, at: '2026-07-13T11:59:40.000Z' },
    ],
    extraMessageIds: [4],
  });

  assert.deepEqual(calls.map((call) => call.payload.message_id), [4, 3, 2]);
  assert.equal(result.deleted, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 1);
});
