import { access, constants as fsConstants } from 'node:fs/promises';

import {
  deleteTrackedTelegramMessages,
  extractTelegramMessageIds,
  normalizeTrackedTelegramMessages,
} from '../telegram-cleanup.js';
import { BusyError } from '../tasks.js';
import { AdmissionError } from '../admission.js';
import { applySourceUpdate, checkSourceUpdate } from '../updater.js';
import { AGYGRAM_VERSION } from '../version.js';
import {
  messageThreadOptions,
  replyLong,
  sendAgyResponse,
  sendAgyResponseFile,
  sendLong,
  sessionKey,
  startTyping,
} from '../telegram.js';
import {
  HELP_TEXT,
  PRIVATE_CLEAR_SWEEP_LIMIT,
  QUICK_HELP_TEXT,
  detach,
  formatDuration,
  formatError,
} from './util.js';

/** Telegram UI panels: menus, doctor, auth, update, clear, last response. */
export function attachPanels(s) {
  const {
    config,
    state,
    tasks,
    auth,
    jobs,
    results,
    agy,
    bot,
    defaultWorkspace,
    backgroundActivities,
    authOwners,
    workspaceFor,
    runAdmittedTask,
    isIdle,
    runControl,
    openChoiceMenu,
    isYoloSession,
    yoloStatus,
    yoloChoices,
    modeChoices,
    sandboxChoices,
    defaultableChoices,
    actionKeyboard,
    mainMenuRows,
    admissions,
  } = s;

  const sendPanel = async (ctx, text, rows, { edit = false } = {}) => {
    const extra = actionKeyboard(rows);
    if (edit) {
      await ctx.editMessageText(text, extra).catch(() => ctx.reply(text, extra));
      return;
    }
    await ctx.reply(text, extra);
  };
  const sendMainMenu = async (ctx, { edit = false, prefix = '' } = {}) => {
    await sendPanel(ctx, `${prefix}${prefix ? '\n\n' : ''}${QUICK_HELP_TEXT}`, mainMenuRows(), { edit });
  };
  const sendFullHelp = async (ctx) => {
    await replyLong(ctx, HELP_TEXT);
  };
  const checklistLine = (ok, text) => `${ok ? '✅' : '⬜'} ${text}`;
  const formatReleaseNotes = (result) => {
    const source = String(result.body || '').replace(/\r/g, '').trim();
    if (!source) return '릴리즈 노트가 비어 있습니다.';
    const lines = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !/^#+\s*/u.test(line))
      .slice(0, 8);
    const text = lines.join('\n');
    return text.length > 900 ? `${text.slice(0, 897)}...` : text;
  };
  const formatUpdatePanel = (result) => {
    if (result.version === result.current) {
      return [
        `✅ 최신 버전입니다. v${result.current}`,
        result.url ? `릴리즈: ${result.url}` : null,
      ].filter(Boolean).join('\n');
    }
    return [
      `⬆️ 업데이트 가능: v${result.current} → v${result.version}`,
      '',
      '변경점',
      formatReleaseNotes(result),
      '',
      result.url ? `릴리즈: ${result.url}` : null,
    ].filter((line) => line != null).join('\n');
  };
  const sendOnboardingPanel = async (ctx, {
    agyVersion,
    catalogStatus,
    authStatus,
    workspace,
    edit = false,
    prefix = '',
  } = {}) => {
    const session = state.get(sessionKey(ctx));
    const authOk = Boolean(authStatus?.authenticated);
    const catalogOk = Boolean(catalogStatus?.available);
    const workspaceOk = Boolean(workspace);
    const text = [
      prefix || 'agygram에 오신 것을 환영합니다.',
      '',
      '처음 쓰는 순서',
      checklistLine(authOk, '인증 완료'),
      checklistLine(catalogOk, 'agy 모델/에이전트 조회 가능'),
      checklistLine(workspaceOk, `작업공간 준비${workspace ? `: ${workspace}` : ''}`),
      checklistLine(Boolean(session.model || session.agent || session.skill), '선택 설정 적용'),
      '',
      agyVersion ? `agy: ${agyVersion}` : 'agy: 확인 필요',
      authOk
        ? '이제 일반 메시지를 보내면 agy가 처리합니다.'
        : '먼저 🔐 인증을 누르고 authorization code를 이 채팅에 붙여넣으세요.',
    ].join('\n');
    await sendPanel(
      ctx,
      text,
      [
        [
          { label: authOk ? '🔐 인증 다시 확인' : '🔐 인증하기', action: 'auth' },
          { label: '🩺 점검', action: 'doctor' },
        ],
        [
          { label: '🧠 모델', action: 'model' },
          { label: '🧩 스킬', action: 'skills' },
        ],
        [
          { label: '⚙️ 모드', action: 'mode' },
          { label: '💬 시작하기', action: 'close' },
        ],
      ],
      { edit },
    );
  };
  const sendDoctorPanel = async (ctx, { edit = false } = {}) => {
    const key = sessionKey(ctx);
    const stopTyping = startTyping(ctx);
    const checks = [];
    const add = (ok, label, detail = '') => {
      checks.push(`${ok ? '✅' : '⚠️'} ${label}${detail ? `: ${detail}` : ''}`);
    };
    const render = () => sendPanel(
      ctx,
      ['🩺 agygram doctor', '', ...checks].join('\n'),
      [
        [
          { label: '🔐 인증', action: 'auth' },
          { label: '⬆️ 업데이트', action: 'update' },
        ],
        [
          { label: 'ℹ️ 세션', action: 'info' },
          { label: '🏠 메뉴', action: 'menu' },
        ],
      ],
      { edit },
    );
    const collect = async (signal = undefined) => {
      const session = state.get(key);
      const busy = tasks.isActive(key) || auth.hasAnyActive();
      add(true, 'agygram', `v${AGYGRAM_VERSION}`);
      add([22, 24].includes(Number(process.versions.node.split('.')[0])), 'Node.js', process.version);
      add(!tasks.isActive(key), '현재 채팅 작업', tasks.isActive(key) ? '진행 중' : 'idle');
      add(!auth.hasAnyActive(), '인증 작업', auth.hasAnyActive() ? '진행 중' : 'idle');
      add(config.allowedChatIds.has(String(ctx.chat.id)), 'Telegram 허용 채팅', String(ctx.chat.id));
      let cwd = null;
      try {
        cwd = await workspaceFor(session);
        await access(cwd, fsConstants.R_OK | fsConstants.W_OK);
        add(true, '작업공간', cwd);
      } catch (error) {
        add(false, '작업공간', error.message);
      }
      if (!cwd) return;
      if (busy) {
        add(false, 'agy 세부 점검', '작업/인증 중이라 무거운 probe는 건너뜀');
        return;
      }
      try {
        const version = await agy.version({ cwd, signal });
        add(true, 'agy 실행 파일', version);
      } catch (error) {
        add(false, 'agy 실행 파일', formatError(error));
      }
      try {
        const catalog = await agy.catalogStatus({ cwd, signal });
        add(catalog.available, '모델 조회', catalog.available
          ? `모델 ${catalog.models.length}개`
          : catalog.detail || catalog.reason || '확인 실패');
      } catch (error) {
        add(false, '모델 조회', error.message);
      }
      try {
        const authStatus = await agy.authenticationStatus({ cwd, signal });
        add(authStatus.authenticated, 'agy 인증', authStatus.authenticated ? '완료' : '/auth 필요');
      } catch (error) {
        add(false, 'agy 인증', formatError(error));
      }
    };
    try {
      if (tasks.isActive(key) || auth.hasAnyActive()) {
        await collect();
      } else {
        await runAdmittedTask(ctx, 'probe:doctor', collect);
      }
      await render();
    } catch (error) {
      await replyLong(ctx, `doctor 실행에 실패했습니다.\n\n${formatError(error)}`);
    } finally {
      stopTyping();
    }
  };
  const rememberTelegramMessages = (key, entries) => {
    if (!entries.length) return;
    detach(
      state.update(key, (session) => ({
        ...session,
        telegramMessages: normalizeTrackedTelegramMessages(session.telegramMessages, entries),
      })),
      'telegram-message-tracking',
      backgroundActivities,
    );
  };
  const rememberTelegramResult = (ctx, result, direction = 'out') => {
    const ids = extractTelegramMessageIds(result);
    if (ids.length === 0) return;
    const at = new Date().toISOString();
    rememberTelegramMessages(
      sessionKey(ctx),
      ids.map((messageId) => ({ messageId, direction, at })),
    );
  };
  const installTelegramMessageTracking = (ctx) => {
    ctx.state ??= {};
    ctx.state.agygramRecordTelegramResult = (result, direction = 'out') => {
      rememberTelegramResult(ctx, result, direction);
    };
    if (ctx.message?.message_id) {
      rememberTelegramMessages(sessionKey(ctx), [{
        messageId: ctx.message.message_id,
        direction: 'in',
        at: new Date((ctx.message.date || Math.floor(Date.now() / 1_000)) * 1_000).toISOString(),
      }]);
    }
    for (const method of ['reply', 'replyWithDocument']) {
      if (typeof ctx[method] !== 'function') continue;
      const original = ctx[method].bind(ctx);
      ctx[method] = async (...args) => {
        const result = await original(...args);
        rememberTelegramResult(ctx, result, 'out');
        return result;
      };
    }
  };
  const sendSessionInfo = async (ctx, { edit = false } = {}) => {
    const key = sessionKey(ctx);
    const session = state.get(key);
    let cwd;
    try {
      cwd = await workspaceFor(session);
    } catch {
      cwd = `${session.workspaceDir} (사용 불가)`;
    }
    const sessionMode = session.conversationId
      ? `agy conversation ${session.conversationId}`
      : `로컬 기록 폴백 ${session.history.length}턴`;
    await sendPanel(
      ctx,
      [
        `agygram v${AGYGRAM_VERSION}`,
        `작업공간: ${cwd}`,
        `대화: ${sessionMode}`,
        `프로젝트: ${session.projectId || (session.newProject ? '다음 요청에서 새로 생성' : '자동')}`,
        `모델: ${session.model || 'agy 기본값'}`,
        `에이전트: ${session.agent || 'agy 기본값'}`,
        `스킬: ${session.skill || '선택 안 함'}`,
        `모드: ${isYoloSession(session) ? 'YOLO' : session.mode}`,
        `샌드박스: ${config.allowUnsandboxedRuns ? (session.sandbox ? '켜짐' : '꺼짐') : '강제 켜짐 (정책)'}`,
        `작업 중: ${tasks.isActive(key) ? '예' : '아니요'}`,
      ].join('\n'),
      [
        [
          { label: '🧠 모델', action: 'model' },
          { label: '👤 에이전트', action: 'agent' },
        ],
        [
          { label: '🧩 스킬', action: 'skills' },
          { label: '⚙️ 모드', action: 'mode' },
        ],
        [
          { label: '📊 상태', action: 'status' },
          { label: '🏠 메뉴', action: 'menu' },
        ],
      ],
      { edit },
    );
  };
  const sendStatusPanel = async (ctx, { edit = false } = {}) => {
    const key = sessionKey(ctx);
    const active = tasks.getStatus(key);
    const last = state.get(key).lastRun;
    const journal = jobs.latestForSession(key);
    let text;
    let rows;
    if (!active) {
      if (!last && !journal) {
        text = '현재 실행 중인 작업도, 기록된 이전 작업도 없습니다.';
      } else if (journal && journal.status !== 'succeeded') {
        text =
          `현재 실행 중인 작업은 없습니다.\n최근 내구 작업: ${journal.id.slice(0, 8)} · ${journal.kind} · ${journal.status}\n` +
          `${journal.status === 'interrupted' ? `/retry ${journal.id.slice(0, 8)} 로 명시 재시도할 수 있습니다.` : ''}`;
      } else if (!last) {
        text = `현재 실행 중인 작업은 없습니다.\n최근 내구 작업: ${journal.id.slice(0, 8)} · ${journal.kind} · ${journal.status}`;
      } else {
        const duration = last.durationMs == null ? '알 수 없음' : formatDuration(last.durationMs);
        text =
          `현재 실행 중인 작업은 없습니다.\n` +
          `마지막 작업: ${last.id || '-'} · ${last.kind} · ${last.status} · ${duration}\n` +
          `응답 전달: ${last.deliveryStatus || '기록 없음'}`;
      }
      rows = [
        [
          { label: '↩️ 마지막 응답', action: 'last' },
          { label: '📜 작업 기록', action: 'jobs' },
        ],
        [
          { label: 'ℹ️ 세션', action: 'info' },
          { label: '🏠 메뉴', action: 'menu' },
        ],
      ];
    } else {
      const origin = active.startedAt || active.queuedAt;
      const elapsed = origin ? formatDuration(Date.now() - Date.parse(origin)) : '알 수 없음';
      const queue = active.state === 'queued' ? ` · 대기 ${active.queuePosition}번` : '';
      text =
        `작업 ${(active.metadata.durableJobId || active.id).slice(0, 8)}\n` +
        `상태: ${active.state}${queue}\n단계: ${active.phase}\n경과: ${elapsed}`;
      rows = [
        [
          { label: '⛔ 중단', action: 'cancel' },
          { label: '🔄 새로고침', action: 'status' },
        ],
        [{ label: '🏠 메뉴', action: 'menu' }],
      ];
    }
    await sendPanel(ctx, text, rows, { edit });
  };
  const openModelMenu = async (ctx, { edit = false } = {}) => {
    if (!(await isIdle(ctx))) return;
    const chatId = sessionKey(ctx);
    const stopTyping = startTyping(ctx);
    try {
      await runAdmittedTask(ctx, 'probe:model', async (signal) => {
        if (auth.hasAnyActive()) throw new BusyError('Authentication is in progress');
        const session = state.get(chatId);
        const cwd = await workspaceFor(session);
        const models = await agy.models({ cwd, signal });
        await openChoiceMenu(ctx, {
          type: 'model',
          title: '모델 선택',
          current: session.model || 'agy 기본값',
          choices: defaultableChoices({
            current: session.model,
            defaultLabel: 'agy 기본값',
            values: models,
          }),
          hint: '원하는 모델을 누르세요. 모델명이 길면 /model <이름> 직접 입력도 가능합니다.',
          edit,
        });
      });
    } catch (error) {
      await replyLong(ctx, formatError(error));
    } finally {
      stopTyping();
    }
  };
  const openAgentMenu = async (ctx, { edit = false } = {}) => {
    if (!(await isIdle(ctx))) return;
    const chatId = sessionKey(ctx);
    const stopTyping = startTyping(ctx);
    try {
      await runAdmittedTask(ctx, 'probe:agent', async (signal) => {
        if (auth.hasAnyActive()) throw new BusyError('Authentication is in progress');
        const session = state.get(chatId);
        const cwd = await workspaceFor(session);
        const agents = await agy.agents({ cwd, signal });
        await openChoiceMenu(ctx, {
          type: 'agent',
          title: '에이전트 선택',
          current: session.agent || 'agy 기본값',
          choices: defaultableChoices({
            current: session.agent,
            defaultLabel: 'agy 기본값',
            values: agents,
          }),
          hint: agents.length > 0
            ? '원하는 에이전트를 누르세요. 에이전트명이 길면 /agent <이름> 직접 입력도 가능합니다.'
            : 'agy가 노출한 추가 에이전트가 없습니다. 기본값만 선택할 수 있습니다.',
          edit,
        });
      });
    } catch (error) {
      await replyLong(ctx, formatError(error));
    } finally {
      stopTyping();
    }
  };
  const openModeMenu = async (ctx, { edit = false } = {}) => {
    await runControl(ctx, async () => {
      const current = state.get(sessionKey(ctx));
      await openChoiceMenu(ctx, {
        type: 'mode',
        title: '실행 모드 선택',
        current: isYoloSession(current) ? 'YOLO' : current.mode,
        choices: modeChoices(current),
        edit,
      });
    });
  };
  const openSandboxMenu = async (ctx, { edit = false } = {}) => {
    await runControl(ctx, async () => {
      const current = state.get(sessionKey(ctx)).sandbox;
      await openChoiceMenu(ctx, {
        type: 'sandbox',
        title: '샌드박스 설정',
        current: config.allowUnsandboxedRuns
          ? (current ? '켜짐' : '꺼짐')
          : '강제 켜짐 (정책)',
        choices: sandboxChoices(config.allowUnsandboxedRuns ? current : true),
        hint: config.allowUnsandboxedRuns
          ? '실행 격리 정책을 선택하세요.'
          : '현재 운영 정책상 꺼짐은 선택할 수 없습니다.',
        edit,
      });
    });
  };
  const openYoloMenu = async (ctx, { edit = false } = {}) => {
    await runControl(ctx, async () => {
      const session = state.get(sessionKey(ctx));
      await openChoiceMenu(ctx, {
        type: 'yolo',
        title: 'YOLO mode',
        current: yoloStatus(session),
        choices: yoloChoices(session),
        hint:
          '고위험 모드입니다. 켜면 다음 일반 요청부터 accept-edits + unsandboxed + --dangerously-skip-permissions로 실행합니다. 개인 서버, 좁은 workspace, git으로 저장된 프로젝트에서만 권장합니다.',
        edit,
      });
    });
  };
  const sendJobsPanel = async (ctx, { edit = false } = {}) => {
    const recent = jobs.listForSession(sessionKey(ctx), { limit: 10 });
    if (recent.length === 0) {
      await sendPanel(ctx, '기록된 작업이 없습니다.', [[{ label: '🏠 메뉴', action: 'menu' }]], { edit });
      return;
    }
    await sendPanel(
      ctx,
      recent
        .map((job) => {
          const time = job.startedAt || job.queuedAt;
          return `${job.id.slice(0, 8)} · ${job.kind} · ${job.status} · 시도 ${job.attempt} · ${time}`;
        })
        .join('\n'),
      [
        [
          { label: '📊 상태', action: 'status' },
          { label: '🏠 메뉴', action: 'menu' },
        ],
      ],
      { edit },
    );
  };
  const runUpdateCommand = async (ctx, { apply = false } = {}) => {
    if (!config.ownerUserIds.has(String(ctx.from?.id)) || ctx.chat.type !== 'private') {
      await ctx.reply('업데이트는 허용된 소유자의 개인 채팅에서만 실행할 수 있습니다.');
      return;
    }
    if (!await isIdle(ctx)) return;
    try {
      const result = apply ? await applySourceUpdate(process.cwd()) : await checkSourceUpdate(process.cwd());
      if (!apply) {
        await sendPanel(
          ctx,
          formatUpdatePanel(result),
          result.version === result.current
            ? [[{ label: '🏠 메뉴', action: 'menu' }]]
            : [
                [
                  { label: `⬆️ v${result.version} 설치`, action: 'update_apply' },
                  { label: '취소', action: 'close' },
                ],
                [{ label: '🏠 메뉴', action: 'menu' }],
              ],
        );
        return;
      }
      if (!result.changed) {
        await sendPanel(ctx, `✅ 이미 최신 버전입니다. v${result.current}`, [[{ label: '🏠 메뉴', action: 'menu' }]]);
        return;
      }
      if (result.managed) {
        const detail = result.scheduled?.unit
          ? ` (${result.scheduled.unit})`
          : '';
        await sendPanel(
          ctx,
          `✅ v${result.version} managed 업데이트를 예약했습니다${detail}.\n\n설치가 완료되면 서비스가 새 릴리즈로 재시작됩니다. 잠시 뒤 /info 또는 /doctor로 확인하세요.`,
          [[{ label: '🩺 점검', action: 'doctor' }], [{ label: '🏠 메뉴', action: 'menu' }]],
        );
        return;
      }
      await sendPanel(
        ctx,
        `✅ v${result.version}을 검증·설치했습니다.\n\n서비스를 재시작합니다. 잠시 뒤 /info 또는 /doctor로 확인하세요.`,
        [[{ label: '🩺 점검', action: 'doctor' }]],
      );
      if (result.restart !== false) setTimeout(() => process.exit(75), 300).unref?.();
    } catch (error) {
      const updateMessage = error?.code === 'UPDATE_CHECK_UNAVAILABLE'
        ? '업데이트 서버에 잠시 연결되지 않아 확인을 완료하지 못했습니다.\n잠시 후 /update 를 다시 실행하세요.'
        : `업데이트하지 않았습니다.\n\n${error.message}`;
      await sendPanel(
        ctx,
        updateMessage,
        [
          [
            { label: '🩺 점검', action: 'doctor' },
            { label: '🏠 메뉴', action: 'menu' },
          ],
        ],
      );
    }
  };
  const startAuthFlow = async (ctx) => {
    if (!config.ownerUserIds.has(String(ctx.from?.id))) {
      await ctx.reply('agy 계정 인증은 OWNER_USER_IDS에 등록된 소유자만 실행할 수 있습니다.');
      return;
    }
    if (config.authPrivateOnly && ctx.chat.type !== 'private') {
      await ctx.reply('보안을 위해 /auth 는 허용된 개인 채팅에서만 실행할 수 있습니다.');
      return;
    }
    const chatId = sessionKey(ctx);
    const threadOptions = messageThreadOptions(ctx);
    const trackedDeliveryOptions = (signal) => ({
      signal,
      onSent: (result) => rememberTelegramResult(ctx, result, 'out'),
    });
    if (tasks.hasAnyActive() || auth.hasAnyActive()) {
      await jobs.markUpdateSeen(ctx.update?.update_id, { decision: 'rejected' });
      await ctx.reply('다른 작업이 진행 중입니다. 완료를 기다리거나 해당 채팅에서 /cancel 을 사용하세요.');
      return;
    }
    const cwd = defaultWorkspace;
    const stopTyping = startTyping(ctx);
    try {
      const status = await runAdmittedTask(ctx, 'probe:auth', (signal) =>
        agy.authenticationStatus({ cwd, signal }));
      if (status?.authenticated) {
        await sendPanel(
          ctx,
          '✅ agy 인증이 이미 완료되어 있습니다.\n\n바로 일반 메시지를 보내면 현재 작업공간에서 agy가 처리합니다.',
          [
            [
              { label: 'ℹ️ 세션', action: 'info' },
              { label: '⚙️ 모드', action: 'mode' },
            ],
            [{ label: '🏠 메뉴', action: 'menu' }],
          ],
        );
        return;
      }
    } catch (error) {
      await replyLong(ctx, `인증 상태 확인에 실패했습니다.\n\n${formatError(error)}`);
      return;
    } finally {
      stopTyping();
    }
    try {
      authOwners.set(chatId, String(ctx.from.id));
      auth.start(chatId, {
        cwd,
        onOutput: (output, { signal }) =>
          sendLong(bot.telegram, ctx.chat.id, output, threadOptions, undefined, trackedDeliveryOptions(signal)),
        onExit: async ({ exitCode, cancelled, timedOut, error, deliverySignal }) => {
          try {
            if (cancelled || timedOut) {
              await sendLong(
                bot.telegram,
                ctx.chat.id,
                timedOut ? '인증 세션 시간이 만료되었습니다.' : '인증을 취소했습니다.',
                threadOptions,
                undefined,
                trackedDeliveryOptions(deliverySignal),
              );
              return;
            }
            await sendLong(
              bot.telegram,
              ctx.chat.id,
              exitCode === 0 && !error
                ? 'OAuth 입력과 실제 headless 요청이 완료되어 agy 인증을 확인했습니다.'
                : `인증 프로세스가 종료되었습니다(exit ${exitCode}). 인증을 확인하지 못했습니다.`,
              threadOptions,
              undefined,
              trackedDeliveryOptions(deliverySignal),
            );
          } finally {
            authOwners.delete(chatId);
          }
        },
      });
    } catch (error) {
      authOwners.delete(chatId);
      await ctx.reply('인증 프로세스를 시작하지 못했습니다. AGY_BIN과 서버 로그를 확인하세요.');
      return;
    }
    try {
      await sendPanel(
        ctx,
        '🔐 agy headless OAuth를 시작했습니다.\n\n' +
          '진행 순서\n' +
          '1. 잠시 후 Google 인증 URL이 오면 브라우저에서 엽니다.\n' +
          '2. 로그인 후 표시되는 authorization code를 복사합니다.\n' +
          '3. 이 Telegram 채팅에 그대로 붙여넣습니다.\n' +
          '4. agygram이 실제 headless 요청으로 인증을 검증합니다.\n\n' +
          '이미 로그인되어 있으면 바로 완료 메시지가 나옵니다.',
        [
          [
            { label: '⛔ 인증 취소', action: 'cancel' },
            { label: '🩺 점검', action: 'doctor' },
          ],
        ],
        );
    } catch (error) {
      console.error('Auth start notification failed', { name: error.name, code: error.code });
      auth.cancel(chatId);
    }
  };
  const cancelActiveWork = async (ctx) => {
    const chatId = sessionKey(ctx);
    const authActive = auth.isActive(chatId);
    const ownsAuth = authOwners.get(chatId) === String(ctx.from?.id);
    const authCancelled = ownsAuth ? auth.cancel(chatId) : false;
    const admissionCancelled = admissions.cancel(chatId);
    const taskCancelled = tasks.cancel(chatId);
    if (authActive && !ownsAuth && !admissionCancelled && !taskCancelled) {
      await ctx.reply('인증을 시작한 소유자만 해당 인증 세션을 취소할 수 있습니다.');
      return;
    }
    await ctx.reply(
      authCancelled || admissionCancelled || taskCancelled
        ? '중단 신호를 보냈습니다.'
        : '진행 중인 작업이 없습니다.',
    );
  };
  const clearChatWindow = async (ctx) => {
    const key = sessionKey(ctx);
    if (auth.hasAnyActive()) {
      await ctx.reply('인증 중에는 /clear 를 실행하지 않습니다. 인증을 끝내거나 /cancel 후 다시 시도하세요.');
      return;
    }
    if (tasks.isActive(key)) {
      await ctx.reply('작업 응답 전송 중에는 /clear 를 실행하지 않습니다. 완료 후 다시 시도하세요.');
      return;
    }
    const progress = await ctx.reply('🧹 채팅창을 정리 중입니다...');
    const currentMessageId = ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id;
    const fallbackMessageIds =
      currentMessageId && ctx.chat.type === 'private'
        ? Array.from(
            { length: Math.min(PRIVATE_CLEAR_SWEEP_LIMIT, currentMessageId) },
            (_, index) => currentMessageId - index,
          )
        : currentMessageId ? [currentMessageId] : [];
    const trackedMessages = state.get(key).telegramMessages
      .filter((entry) => entry.messageId !== progress.message_id);
    const result = await deleteTrackedTelegramMessages({
      telegram: ctx.telegram,
      chatId: ctx.chat.id,
      messages: trackedMessages,
      extraMessageIds: fallbackMessageIds,
    });
    await state.update(key, (session) => ({ ...session, telegramMessages: [] }));
    const scan = ctx.chat.type === 'private' && fallbackMessageIds.length > 0
      ? `\n스캔 범위: 최근 ${fallbackMessageIds.length}개 후보`
      : '';
    const limited = result.failed > 0 || result.skipped > 0
      ? '\n남은 메시지는 Telegram 삭제 제한, 이미 삭제된 메시지, 또는 권한 제한 때문일 수 있습니다.'
      : '';
    const text = result.deleted > 0
        ? `최근 대화 메시지 ${result.deleted}개를 정리했습니다.${scan}${limited}`
        : `정리할 수 있는 최근 메시지를 찾지 못했습니다.${scan}${limited}`;
    await ctx.telegram.callApi('editMessageText', {
      chat_id: ctx.chat.id,
      message_id: progress.message_id,
      text,
    }).catch(() => ctx.reply(text));
  };
  const sendLastResponse = async (ctx) => {
    const key = sessionKey(ctx);
    let release;
    let storedLease = null;
    let deliverySignal = null;
    try {
      release = admissions.reserve({
        token: `delivery:${ctx.update?.update_id}`,
        sessionKey: key,
        userId: String(ctx.from?.id ?? 'unknown'),
        sessionAlreadyActive: tasks.isActive(key),
      });
    } catch (error) {
      if (!(error instanceof AdmissionError)) throw error;
      await replyLong(ctx, '현재 작업 또는 응답 전송이 진행 중입니다. 잠시 후 /last 를 다시 실행하세요.');
      return;
    }
    try {
      await tasks.run(key, async (signal, job) => {
        deliverySignal = signal;
        job.update('sending-result');
        const sessionLast = state.get(key).lastRun;
        const latestJournal = sessionLast ? jobs.get(sessionLast.id) : jobs.latestSucceededForSession(key);
        const last = sessionLast || (latestJournal
          ? {
              id: latestJournal.id,
              responseText: latestJournal.result?.responseText || null,
            }
          : null);
        if (!last) {
          await replyLong(ctx, '다시 보낼 수 있는 이전 agy 응답이 없습니다.', undefined, { signal });
          return;
        }
        const persistedPreview = (latestJournal || jobs.get(last.id))?.result;
        try {
          storedLease = await results.acquire(last.id);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            console.warn('Stored result metadata failed', { code: error.code, name: error.name });
          }
        }
        if (storedLease?.size > config.maxRedeliveryBytes) {
          await replyLong(
            ctx,
            `마지막 응답이 재전송 한도(${Math.floor(config.maxRedeliveryBytes / 1024 / 1024)} MiB)를 초과합니다. 서버의 보존 결과를 직접 확인하세요.`,
            undefined,
            { signal },
          );
          return;
        }
        let fullResult = false;
        if (storedLease && storedLease.size > config.maxInlineResponseChars) {
          await sendAgyResponseFile(ctx, storedLease.file, { signal });
          fullResult = true;
        } else {
          const responseText = storedLease
            ? await results.read(last.id)
            : last.responseText || persistedPreview?.responseText || null;
          if (!responseText) {
            await replyLong(
              ctx,
              '마지막 응답의 보존 기간이 끝났거나 저장된 결과가 없습니다.',
              undefined,
              { signal },
            );
            return;
          }
          await sendAgyResponse(ctx, responseText, config.maxInlineResponseChars, { signal });
          fullResult = Boolean(storedLease);
        }
        if (!fullResult && !last.responseText && persistedPreview?.responseTruncated) {
          await replyLong(
            ctx,
            '주의: 전체 결과 파일이 만료되어 journal에 남은 축약본만 전송했습니다.',
            undefined,
            { signal },
          );
        }
        if (sessionLast) {
          await state.update(key, (current) => ({
            ...current,
            lastRun:
              current.lastRun?.id === last.id
                ? { ...current.lastRun, deliveryStatus: 'delivered' }
                : current.lastRun,
          }));
        }
        const persisted = jobs.get(last.id);
        if (persisted?.status === 'succeeded') {
          await jobs.transition(last.id, 'succeeded', { delivered: true });
        }
      }, { kind: 'delivery' });
    } catch (error) {
      console.error('Last response delivery failed', { name: error.name, code: error.code });
      await replyLong(
        ctx,
        '응답 재전송에 실패했습니다. 잠시 후 /last 를 다시 실행하세요.',
        undefined,
        { signal: deliverySignal, retry: { maxAttempts: 1, attemptTimeoutMs: 5_000 } },
      ).catch(() => {});
    } finally {
      if (storedLease) {
        await storedLease.release().catch((error) => {
          console.warn('Result redelivery lease release failed', { code: error.code, name: error.name });
        });
      }
      release?.();
    }
  };


  Object.assign(s, {
    sendPanel,
    sendMainMenu,
    sendFullHelp,
    checklistLine,
    formatReleaseNotes,
    formatUpdatePanel,
    sendOnboardingPanel,
    sendDoctorPanel,
    rememberTelegramMessages,
    rememberTelegramResult,
    installTelegramMessageTracking,
    sendSessionInfo,
    sendStatusPanel,
    openModelMenu,
    openAgentMenu,
    openModeMenu,
    openSandboxMenu,
    openYoloMenu,
    sendJobsPanel,
    runUpdateCommand,
    startAuthFlow,
    cancelActiveWork,
    clearChatWindow,
    sendLastResponse,
  });
}

