import { randomBytes } from 'node:crypto';

export const INTERACTIVE_CALLBACK_PATTERN = /^ui:([A-Za-z0-9_-]{12}):(\d+)$/;
export const ACTION_CALLBACK_PATTERN = /^tg:([a-z][a-z0-9_-]{0,31})$/;
export const INTERACTIVE_MENU_TTL_MS = 10 * 60 * 1_000;

const CALLBACK_PREFIX = 'ui';
const ACTION_CALLBACK_PREFIX = 'tg';
const MAX_BUTTON_LABEL_CHARS = 60;
const ACTION_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function createMenuToken() {
  return randomBytes(9).toString('base64url');
}

export function truncateButtonLabel(label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim() || '-';
  if (text.length <= MAX_BUTTON_LABEL_CHARS) return text;
  return `${text.slice(0, MAX_BUTTON_LABEL_CHARS - 1)}…`;
}

export function buildChoiceKeyboard(token, choices, { columns = 1 } = {}) {
  const safeColumns = Math.min(3, Math.max(1, Math.trunc(columns) || 1));
  const rows = [];
  let current = [];
  choices.forEach((choice, index) => {
    current.push({
      text: truncateButtonLabel(choice.label),
      callback_data: `${CALLBACK_PREFIX}:${token}:${index}`,
    });
    if (current.length >= safeColumns) {
      rows.push(current);
      current = [];
    }
  });
  if (current.length > 0) rows.push(current);
  return { inline_keyboard: rows };
}

export function buildActionKeyboard(rows) {
  return {
    inline_keyboard: rows.map((row) => row.map((button) => {
      const action = String(button.action || '');
      if (!ACTION_NAME_PATTERN.test(action)) {
        throw new Error(`Invalid Telegram action callback: ${action}`);
      }
      return {
        text: truncateButtonLabel(button.label),
        callback_data: `${ACTION_CALLBACK_PREFIX}:${action}`,
      };
    })),
  };
}

export function parseChoiceCallback(data) {
  const match = String(data || '').match(INTERACTIVE_CALLBACK_PATTERN);
  if (!match) return null;
  return {
    token: match[1],
    index: Number(match[2]),
  };
}

export function parseActionCallback(data) {
  const match = String(data || '').match(ACTION_CALLBACK_PATTERN);
  return match ? match[1] : null;
}

export function currentMarker(value, current) {
  return Object.is(value, current) ? '✓ ' : '';
}

export function formatChoiceMenuText({ title, current, hint }) {
  return [
    title,
    `현재: ${current}`,
    hint || '아래 버튼으로 선택하세요. 직접 입력도 계속 지원합니다.',
  ].filter(Boolean).join('\n');
}

export function createChoiceMenu({
  token = createMenuToken(),
  sessionKey,
  actorUserId,
  type,
  choices,
  now = Date.now(),
  ttlMs = INTERACTIVE_MENU_TTL_MS,
}) {
  return {
    token,
    sessionKey,
    actorUserId: String(actorUserId ?? ''),
    type,
    choices: choices.map((choice) => ({ ...choice })),
    expiresAt: now + ttlMs,
  };
}
