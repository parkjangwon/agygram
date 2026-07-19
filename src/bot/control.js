import path from 'node:path';
import { createHash } from 'node:crypto';

import { AdmissionController, AdmissionError } from '../admission.js';
import {
  downloadTelegramFile,
  releaseUploadLease,
} from '../files.js';
import {
  buildActionKeyboard,
  buildChoiceKeyboard,
  createChoiceMenu,
  currentMarker,
  formatChoiceMenuText,
} from '../interactive-ui.js';
import { BusyError } from '../tasks.js';
import { filterSkills, listAgySkills } from '../skills.js';
import { resolveWorkspace } from '../workspace.js';
import {
  replyLong,
  sessionKey,
  storageScope,
} from '../telegram.js';
import { formatError } from './util.js';

/** Workspace, admission, choice menus, and session policy helpers. */
export function attachControl(s) {
  const {
    config,
    state,
    tasks,
    auth,
    jobs,
    defaultWorkspace,
    allowedRoots,
    uploadActiveLeaseMaxAgeMs,
  } = s;

  const workspaceFor = async (session) =>
    resolveWorkspace(session.workspaceDir || defaultWorkspace, {
      defaultWorkspace,
      allowedRoots,
    });

  const activeJournalJobs = new Map();
  const admissions = new AdmissionController({
    maxTotal: config.maxPendingAgyJobs,
    maxPerUser: Math.min(config.maxPendingAgyJobsPerUser, config.maxPendingAgyJobs),
  });
  const historyDigest = (history) =>
    createHash('sha256').update(JSON.stringify(history || [])).digest('hex');
  const snapshotExecutionContext = async (chatId, payload, { touch = false } = {}) => {
    const session = touch ? await state.ensure(chatId) : state.get(chatId);
    const workspaceDir = await workspaceFor(session);
    const requested = { ...session, ...(payload.sessionOverrides || {}) };
    return {
      workspaceDir,
      conversationId: session.conversationId,
      projectId: session.projectId,
      newProject: session.newProject,
      model: requested.model,
      agent: requested.agent,
      skill: requested.skill,
      mode: requested.mode,
      sandbox: config.allowUnsandboxedRuns ? requested.sandbox : true,
      historyDigest: historyDigest(session.history),
      executionGeneration: session.executionGeneration,
      sessionRevision: session.revision,
    };
  };

  const assertExecutionContext = async (chatId, expected) => {
    if (!expected || typeof expected !== 'object') {
      throw new Error('작업 실행 컨텍스트가 없어 안전하게 실행할 수 없습니다. 새 요청을 보내세요.');
    }
    const current = await snapshotExecutionContext(chatId, {
      sessionOverrides: { mode: expected.mode, sandbox: expected.sandbox },
    });
    for (const field of [
      'workspaceDir',
      'conversationId',
      'projectId',
      'newProject',
      'model',
      'agent',
      'skill',
      'historyDigest',
      'executionGeneration',
      'sessionRevision',
    ]) {
      if (current[field] !== expected[field]) {
        const error = new Error(
          `작업 생성 후 ${field} 컨텍스트가 바뀌어 실행을 차단했습니다. 현재 상태에 맞는 새 요청을 보내세요.`,
        );
        error.code = 'JOB_CONTEXT_CHANGED';
        throw error;
      }
    }
    return expected;
  };
  const prepareDurablePayload = async (ctx, payload, signal) => {
    const sessionOverrides = {};
    if (['plan', 'accept-edits'].includes(payload?.sessionOverrides?.mode)) {
      sessionOverrides.mode = payload.sessionOverrides.mode;
    }
    if (typeof payload?.sessionOverrides?.sandbox === 'boolean') {
      sessionOverrides.sandbox = payload.sessionOverrides.sandbox;
    }
    if (payload?.type === 'request') {
      return {
        prompt: String(payload.prompt || ''),
        addDirs: [],
        kind: payload.kind || 'prompt',
        sessionOverrides,
        executionContext: payload.executionContext,
      };
    }
    if (payload?.type === 'document' || payload?.type === 'photo') {
      const fallbackName = payload.type === 'photo' ? 'photo.jpg' : 'document.bin';
      const savedPath = await downloadTelegramFile(
        ctx,
        {
          fileId: payload.fileId,
          fileName: payload.fileName || fallbackName,
          fileSize: payload.fileSize,
        },
        {
          uploadsDir: config.uploadsDir,
          maxBytes: config.maxUploadBytes,
          signal,
          scopeId: storageScope(ctx),
          retentionMs: config.uploadRetentionHours * 60 * 60 * 1_000,
          maxTotalBytes: config.maxUploadStorageBytes,
          activeLeaseMaxAgeMs: uploadActiveLeaseMaxAgeMs,
        },
      );
      const requested = String(payload.caption || '').trim();
      const label = payload.type === 'photo' ? '이미지' : '파일';
      return {
        prompt:
          `텔레그램에서 업로드된 ${label}을 확인해 주세요.\n${label} 경로: ${savedPath}\n` +
          `${payload.type === 'document' ? `원래 파일명: ${payload.fileName || fallbackName}\n` : ''}` +
          `요청: ${requested || (payload.type === 'photo' ? '이미지를 분석해 주세요.' : '파일을 분석하고 핵심 내용을 설명해 주세요.')}`,
        addDirs: [path.dirname(savedPath)],
        kind: payload.kind || 'prompt',
        sessionOverrides,
        executionContext: payload.executionContext,
        cleanup: () => releaseUploadLease(savedPath),
      };
    }
    throw new Error('지원하지 않는 내구 작업 payload입니다.');
  };

  const runAdmittedTask = async (ctx, kind, operation) => {
    const chatId = sessionKey(ctx);
    const token = `control:${ctx.update?.update_id}:${kind}`;
    let release;
    try {
      release = admissions.reserve({
        token,
        sessionKey: chatId,
        userId: String(ctx.from?.id ?? 'unknown'),
        sessionAlreadyActive: tasks.isActive(chatId),
      });
    } catch (error) {
      if (error instanceof AdmissionError) throw new BusyError(error.message);
      throw error;
    }
    try {
      return await tasks.run(chatId, operation, { kind });
    } finally {
      release();
    }
  };

  const isIdle = async (ctx) => {
    const chatId = sessionKey(ctx);
    if (tasks.isActive(chatId) || auth.hasAnyActive()) {
      await jobs.markUpdateSeen(ctx.update?.update_id, { decision: 'rejected' });
      await ctx.reply('진행 중인 작업이 있습니다. 먼저 /cancel 로 중단하세요.');
      return false;
    }
    return true;
  };

  const runControl = async (ctx, operation) => {
    if (auth.hasAnyActive()) {
      await jobs.markUpdateSeen(ctx.update?.update_id, { decision: 'rejected' });
      await ctx.reply('인증 작업 중에는 세션 설정을 바꿀 수 없습니다.');
      return;
    }
    try {
      await runAdmittedTask(ctx, 'control', async () => operation());
    } catch (error) {
      await jobs.markUpdateSeen(ctx.update?.update_id, { decision: 'rejected' });
      await replyLong(ctx, formatError(error));
    }
  };

  const interactiveMenus = new Map();
  const cleanupInteractiveMenus = () => {
    const now = Date.now();
    for (const [token, menu] of interactiveMenus) {
      if (menu.expiresAt <= now) interactiveMenus.delete(token);
    }
  };
  const openChoiceMenu = async (ctx, {
    type,
    title,
    current,
    choices,
    hint,
    columns = 1,
    edit = false,
  }) => {
    cleanupInteractiveMenus();
    const menu = createChoiceMenu({
      sessionKey: sessionKey(ctx),
      actorUserId: ctx.from?.id,
      type,
      choices,
    });
    interactiveMenus.set(menu.token, menu);
    const text = formatChoiceMenuText({ title, current, hint });
    const extra = { reply_markup: buildChoiceKeyboard(menu.token, menu.choices, { columns }) };
    if (edit) await ctx.editMessageText(text, extra).catch(() => ctx.reply(text, extra));
    else await ctx.reply(text, extra);
  };
  const acknowledgeChoice = async (ctx, text, { alert = false } = {}) => {
    const message = String(text || '').length > 180
      ? `${String(text).slice(0, 179)}…`
      : String(text || '');
    await ctx.answerCbQuery(message, { show_alert: alert }).catch(() => {});
  };
  const runChoiceControl = async (ctx, operation) => {
    if (auth.hasAnyActive()) {
      await jobs.markUpdateSeen(ctx.update?.update_id, { decision: 'rejected' });
      await acknowledgeChoice(ctx, '인증 작업 중에는 설정을 바꿀 수 없습니다.', { alert: true });
      return;
    }
    try {
      await runAdmittedTask(ctx, 'control:button', async () => operation());
    } catch (error) {
      await jobs.markUpdateSeen(ctx.update?.update_id, { decision: 'rejected' });
      await acknowledgeChoice(ctx, formatError(error), { alert: true });
    }
  };
  const finishChoiceMessage = async (ctx, text) => {
    await ctx.editMessageText(text).catch(() => ctx.reply(text));
  };
  const yoloPolicyError = () => {
    if (!config.allowUnsandboxedRuns) {
      return 'YOLO mode는 ALLOW_UNSANDBOXED_RUNS=true가 필요합니다. 전용 저권한 계정과 좁은 workspace에서만 켜세요.';
    }
    if (!config.allowUnsandboxedAutoApprove) {
      return 'YOLO mode는 ALLOW_UNSANDBOXED_AUTO_APPROVE=true가 필요합니다. 이 설정은 --dangerously-skip-permissions를 unsandboxed로 사용합니다.';
    }
    return null;
  };
  const isYoloSession = (session) => session.mode === 'accept-edits' && session.sandbox === false;
  const yoloStatus = (session) => {
    if (isYoloSession(session)) {
      return config.allowUnsandboxedAutoApprove
        ? '켜짐 (accept-edits + unsandboxed + dangerously-skip-permissions)'
        : '요청됨, 하지만 자동 승인 정책 꺼짐';
    }
    return '꺼짐';
  };
  const enableYolo = async (key) => {
    const policyError = yoloPolicyError();
    if (policyError) return policyError;
    await state.update(key, (session) => ({
      ...session,
      mode: 'accept-edits',
      sandbox: false,
    }));
    return null;
  };
  const disableYolo = async (key) => {
    await state.update(key, (session) => ({
      ...session,
      mode: 'accept-edits',
      sandbox: true,
    }));
  };
  const yoloChoices = (session) => [
    {
      label: `${isYoloSession(session) ? '✓ ' : ''}YOLO 켜기 · 자동 승인`,
      action: 'yolo-on',
    },
    {
      label: `${!isYoloSession(session) ? '✓ ' : ''}YOLO 끄기 · sandbox code`,
      action: 'yolo-off',
    },
    { label: '닫기', action: 'cancel' },
  ];
  const modeChoices = (session) => [
    {
      label: `${currentMarker('plan', session.mode)}Plan · 수정 없이 계획`,
      value: 'plan',
    },
    {
      label: `${session.mode === 'accept-edits' && session.sandbox !== false ? '✓ ' : ''}Code · 파일 수정 허용`,
      value: 'accept-edits',
    },
    {
      label: `${isYoloSession(session) ? '✓ ' : ''}YOLO · 묻지 않고 수정`,
      action: 'yolo-on',
    },
    { label: '닫기', action: 'cancel' },
  ];
  const sandboxChoices = (current) => [
    {
      label: `${currentMarker(true, current)}켜짐 · 안전 기본값`,
      value: true,
    },
    {
      label: `${currentMarker(false, current)}꺼짐 · 신뢰 실행`,
      value: false,
    },
    { label: '닫기', action: 'cancel' },
  ];
  const defaultableChoices = ({ current, defaultLabel, values }) => [
    {
      label: `${current == null ? '✓ ' : ''}${defaultLabel}`,
      value: null,
    },
    ...values.map((value) => ({
      label: `${currentMarker(value, current)}${value}`,
      value,
    })),
    { label: '닫기', action: 'cancel' },
  ];
  const skillPageSize = 8;
  const formatSkillLabel = (skill, activeSkill) => {
    const prefix = skill.name === activeSkill ? '✓ ' : '';
    const description = skill.description ? ` — ${skill.description}` : '';
    return `${prefix}${skill.name}${description}`;
  };
  const skillChoices = ({ skills, page, query, activeSkill }) => {
    const totalPages = Math.max(1, Math.ceil(skills.length / skillPageSize));
    const safePage = Math.min(totalPages - 1, Math.max(0, page));
    const visible = skills.slice(safePage * skillPageSize, (safePage + 1) * skillPageSize);
    const choices = visible.map((skill) => ({
      label: formatSkillLabel(skill, activeSkill),
      value: skill.name,
      action: 'skill-set',
    }));
    if (skills.length > 0) {
      choices.push({
        label: `페이지 ${safePage + 1}/${totalPages}`,
        action: 'noop',
      });
    }
    const navigation = [];
    if (safePage > 0) {
      navigation.push({ label: '◀ 이전', action: 'skills-page', page: safePage - 1, query });
    }
    if (safePage < totalPages - 1) {
      navigation.push({ label: '다음 ▶', action: 'skills-page', page: safePage + 1, query });
    }
    choices.push(...navigation);
    choices.push({ label: '선택 해제', action: 'skill-clear' });
    choices.push({ label: '닫기', action: 'cancel' });
    return { choices, page: safePage, totalPages };
  };
  const openSkillsMenu = async (ctx, { query = '', page = 0, edit = false, signal } = {}) => {
    const session = state.get(sessionKey(ctx));
    const allSkills = await listAgySkills({ env: process.env, signal });
    const skills = filterSkills(allSkills, query);
    const { choices, page: safePage, totalPages } = skillChoices({
      skills,
      page,
      query,
      activeSkill: session.skill,
    });
    const searchText = query ? ` · 검색: ${query}` : '';
    const emptyHint = query
      ? '검색 결과가 없습니다. /skills 로 전체 목록을 다시 열 수 있습니다.'
      : '발견된 SKILL.md가 없습니다. Antigravity skill 또는 plugin 설치 상태를 확인하세요.';
    await openChoiceMenu(ctx, {
      type: 'skills',
      title: `Agent skills${searchText}`,
      current: session.skill || '선택 안 함',
      choices,
      hint: skills.length > 0
        ? `총 ${skills.length}개 · ${safePage + 1}/${totalPages}페이지. 스킬을 누르면 이후 요청에 적용됩니다. 검색: /skills 키워드`
        : emptyHint,
      edit,
    });
  };

  const withCloseRow = (rows) => {
    const hasClose = rows.some((row) => row.some((button) => button.action === 'close'));
    return hasClose ? rows : [...rows, [{ label: '닫기', action: 'close' }]];
  };
  const actionKeyboard = (rows) => ({ reply_markup: buildActionKeyboard(withCloseRow(rows)) });
  const mainMenuRows = () => [
    [
      { label: '📊 상태', action: 'status' },
      { label: '🩺 점검', action: 'doctor' },
    ],
    [
      { label: '🧠 모델', action: 'model' },
      { label: '👤 에이전트', action: 'agent' },
    ],
    [
      { label: '🧩 스킬', action: 'skills' },
      { label: '⚙️ 모드', action: 'mode' },
    ],
    [
      { label: '🛡 샌드박스', action: 'sandbox' },
      { label: '⚡ YOLO', action: 'yolo' },
    ],
    [
      { label: '↩️ 마지막 응답', action: 'last' },
      { label: '📜 작업 기록', action: 'jobs' },
    ],
    [
      { label: '🧹 정리', action: 'clear' },
      { label: 'ℹ️ 세션', action: 'info' },
    ],
    [
      { label: '🔐 인증', action: 'auth' },
      { label: '⬆️ 업데이트', action: 'update' },
    ],
  ];

  Object.assign(s, {
    workspaceFor,
    activeJournalJobs,
    admissions,
    historyDigest,
    snapshotExecutionContext,
    assertExecutionContext,
    prepareDurablePayload,
    runAdmittedTask,
    isIdle,
    runControl,
    interactiveMenus,
    cleanupInteractiveMenus,
    openChoiceMenu,
    acknowledgeChoice,
    runChoiceControl,
    finishChoiceMessage,
    yoloPolicyError,
    isYoloSession,
    yoloStatus,
    enableYolo,
    disableYolo,
    yoloChoices,
    modeChoices,
    sandboxChoices,
    defaultableChoices,
    skillPageSize,
    formatSkillLabel,
    skillChoices,
    openSkillsMenu,
    withCloseRow,
    actionKeyboard,
    mainMenuRows,
  });
}

