import { Telegraf } from 'telegraf';

import { AgyClient } from '../agy.js';
import { AuthManager } from '../auth.js';
import { buildAgyEnvironment } from '../environment.js';
import { LifecycleController } from '../lifecycle.js';
import { resolveProcessExecutable } from '../process-platform.js';
import { KeyedMutex, TaskManager } from '../tasks.js';
import { guardTelegramClient } from '../telegram.js';
import { synchronizeBotCommandMenu } from '../command-menu.js';

import { attachControl } from './control.js';
import { registerHandlers } from './handlers.js';
import { attachJobs } from './jobs.js';
import { attachPanels } from './panels.js';
import { warnWithCooldown } from './util.js';

/**
 * Build the Telegram bot runtime (agy client, tasks, handlers) and run until stop.
 *
 * @param {object} options
 * @param {object} options.config
 * @param {string} options.defaultWorkspace
 * @param {string[]} options.allowedRoots
 * @param {import('../results.js').ResultStore} options.results
 * @param {import('../state.js').StateStore} options.state
 * @param {import('../job-store.js').JobStore} options.jobs
 * @param {import('../usage-store.js').UsageStore} options.usage
 * @param {object[]} options.recoveryCandidates
 * @param {number} options.uploadActiveLeaseMaxAgeMs
 * @param {import('../activity.js').ActivityTracker} options.backgroundActivities
 * @param {object|null} options.serviceStopMonitor
 * @param {(handles: object) => void} [options.onRuntimeReady]
 */
export async function runTelegramApp({
  config,
  defaultWorkspace,
  allowedRoots,
  results,
  state,
  jobs,
  usage,
  recoveryCandidates,
  uploadActiveLeaseMaxAgeMs,
  backgroundActivities,
  serviceStopMonitor,
  onRuntimeReady,
}) {
  const agyEnvironment = buildAgyEnvironment(process.env, config.agyEnvironmentAllowlist);
  const agyExecutable = (
    await resolveProcessExecutable(config.agyBin, {
      env: agyEnvironment,
      cwd: defaultWorkspace,
    })
  ).path;

  const agy = new AgyClient({
    bin: agyExecutable,
    timeoutMs: config.agyTimeoutMs,
    authCheckTimeoutMs: config.authCheckTimeoutMs,
    maxOutputBytes: config.agyMaxOutputBytes,
    allowUnsandboxedAutoApprove: config.allowUnsandboxedAutoApprove,
    runLogDir: config.captureAgyRunMetadata ? config.agyRunLogDir : null,
    keepRunLogs: config.keepAgyRunLogs,
    runLogRetentionMs: config.agyRunLogRetentionHours * 60 * 60 * 1_000,
    runLogMaxTotalBytes: config.maxAgyRunLogStorageBytes,
    runLogMaxFileBytes: config.maxAgyRunLogFileBytes,
    environment: agyEnvironment,
  });
  const agyCompatibility = await agy.assertCompatibleVersion({
    cwd: defaultWorkspace,
    minVersion: config.agyMinVersion,
    enforce: config.enforceAgyMinVersion,
  });
  if (agyCompatibility.ok === null) {
    warnWithCooldown(
      'agy-version-unparseable',
      `Could not parse agy version output ("${agyCompatibility.raw}"). ` +
      `Skipping strict version gate; expected minimum is ${config.agyMinVersion}.`,
    );
  } else if (!agyCompatibility.ok) {
    warnWithCooldown(
      'agy-version-unsupported',
      `Unsupported agy version detected (${agyCompatibility.raw}). ` +
      `Configured minimum is ${config.agyMinVersion}. Continuing because AGY_ENFORCE_MIN_VERSION=false.`,
    );
  }

  const auth = new AuthManager({
    bin: agyExecutable,
    timeoutMs: config.authTimeoutMs,
    forceRemote: config.authForceRemote,
    transport: process.env.AGY_AUTH_TRANSPORT || 'pty',
    environment: agyEnvironment,
  });
  const authOwners = new Map();
  const tasks = new TaskManager(config.maxConcurrentAgy, {
    maxQueueWaitMs: config.agyQueueTimeoutMs,
    overloadThreshold: config.agyQueueOverloadThresholdPercent / 100,
    overloadQueueWaitMs: config.agyQueueOverloadTimeoutMs,
    maxActive: Math.max(config.maxConcurrentAgy, config.maxPendingAgyJobs),
  });
  const workspaceLocks = new KeyedMutex();
  const bot = new Telegraf(config.botToken, {
    // A chat can wait behind another allowed chat's agy process.
    handlerTimeout: Math.max(config.agyTimeoutMs + 90_000, 24 * 60 * 60 * 1_000),
  });
  guardTelegramClient(bot.telegram);

  const s = {
    config,
    defaultWorkspace,
    allowedRoots,
    results,
    state,
    jobs,
    usage,
    recoveryCandidates,
    uploadActiveLeaseMaxAgeMs,
    backgroundActivities,
    agy,
    auth,
    authOwners,
    tasks,
    workspaceLocks,
    bot,
    agyExecutable,
  };

  attachControl(s);
  attachPanels(s);
  attachJobs(s);
  registerHandlers(s);

  const lifecycle = new LifecycleController({
    bot,
    tasks,
    auth,
    admissions: s.admissions,
  });
  serviceStopMonitor?.setHandler((reason) => lifecycle.requestStop(reason));
  onRuntimeReady?.({
    tasks,
    auth,
    admissions: s.admissions,
    lifecycle,
  });

  const removeSignalHandlers = lifecycle.installSignalHandlers(process);
  try {
    await lifecycle.start({
      setCommands: (startupSignal) => synchronizeBotCommandMenu(bot, {
        allowedChatIds: config.allowedChatIds,
        signal: startupSignal,
      }),
      launchOptions: { dropPendingUpdates: false },
      onLaunch: () => {
        console.log(`Antigravity Telegram bot started with agy at ${agyExecutable}`);
        void (async () => {
          try {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            await s.sendRecoveryNotifications(bot, recoveryCandidates, jobs);
          } catch (err) {
            console.error('Error sending startup recovery notifications', err);
          }
        })();
      },
    });
  } finally {
    removeSignalHandlers();
  }
}
