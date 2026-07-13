import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActionKeyboard,
  buildChoiceKeyboard,
  createChoiceMenu,
  currentMarker,
  formatChoiceMenuText,
  parseActionCallback,
  parseChoiceCallback,
  truncateButtonLabel,
} from '../src/interactive-ui.js';

test('interactive choice keyboard uses short tokenized callback data', () => {
  const keyboard = buildChoiceKeyboard('abcABC123_-_', [
    { label: 'agy 기본값', value: null },
    { label: 'Gemini 3.5 Flash with a very long visible label that should be truncated', value: 'x' },
  ]);

  assert.deepEqual(keyboard.inline_keyboard[0][0], {
    text: 'agy 기본값',
    callback_data: 'ui:abcABC123_-_:0',
  });
  assert.equal(keyboard.inline_keyboard[1][0].callback_data, 'ui:abcABC123_-_:1');
  assert.ok(keyboard.inline_keyboard[1][0].text.endsWith('…'));
  assert.ok(keyboard.inline_keyboard[1][0].callback_data.length <= 64);
});

test('interactive choice keyboard supports compact rows', () => {
  const keyboard = buildChoiceKeyboard('abcABC123_-_', [
    { label: 'A', value: 'a' },
    { label: 'B', value: 'b' },
    { label: 'C', value: 'c' },
  ], { columns: 2 });

  assert.equal(keyboard.inline_keyboard.length, 2);
  assert.equal(keyboard.inline_keyboard[0].length, 2);
  assert.equal(keyboard.inline_keyboard[1].length, 1);
});

test('telegram action keyboard uses stable short callback data', () => {
  const keyboard = buildActionKeyboard([
    [
      { label: '상태', action: 'status' },
      { label: '실행 모드', action: 'mode' },
    ],
    [{ label: '업데이트 적용', action: 'update_apply' }],
  ]);

  assert.deepEqual(keyboard.inline_keyboard[0][0], {
    text: '상태',
    callback_data: 'tg:status',
  });
  assert.equal(keyboard.inline_keyboard[0][1].callback_data, 'tg:mode');
  assert.equal(keyboard.inline_keyboard[1][0].callback_data, 'tg:update_apply');
  assert.equal(parseActionCallback('tg:update_apply'), 'update_apply');
  assert.equal(parseActionCallback('ui:abcABC123_-_:1'), null);
});

test('telegram action keyboard rejects invalid callback names', () => {
  assert.throws(
    () => buildActionKeyboard([[{ label: 'bad', action: '../bad' }]]),
    /Invalid Telegram action callback/,
  );
});

test('interactive callback parser rejects non-menu data', () => {
  assert.deepEqual(parseChoiceCallback('ui:abcABC123_-_:42'), {
    token: 'abcABC123_-_',
    index: 42,
  });
  assert.equal(parseChoiceCallback('/model'), null);
  assert.equal(parseChoiceCallback('ui:too-short:1'), null);
});

test('interactive menu records actor, session, choices, and expiry', () => {
  const menu = createChoiceMenu({
    token: 'abcABC123_-_',
    sessionKey: '-100:7',
    actorUserId: 123,
    type: 'model',
    choices: [{ label: 'default', value: null }],
    now: 1_000,
    ttlMs: 5_000,
  });

  assert.equal(menu.token, 'abcABC123_-_');
  assert.equal(menu.sessionKey, '-100:7');
  assert.equal(menu.actorUserId, '123');
  assert.equal(menu.expiresAt, 6_000);
  assert.deepEqual(menu.choices, [{ label: 'default', value: null }]);
});

test('interactive menu text and markers are stable', () => {
  assert.equal(currentMarker('plan', 'plan'), '✓ ');
  assert.equal(currentMarker('plan', 'accept-edits'), '');
  assert.equal(truncateButtonLabel('  hello   world  '), 'hello world');
  assert.equal(formatChoiceMenuText({
    title: '모델 선택',
    current: 'agy 기본값',
    hint: '아래 버튼',
  }), '모델 선택\n현재: agy 기본값\n아래 버튼');
});
