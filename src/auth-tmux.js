import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`;
}

function usage() {
  throw new Error('Usage: auth-tmux.js <agy-bin> <cwd> -- <agy arguments>');
}

const separator = process.argv.indexOf('--');
if (separator < 3) usage();
const [agyBin, cwd] = process.argv.slice(2, separator);
const agyArgs = process.argv.slice(separator + 1);
if (!agyBin || !cwd || agyArgs.length === 0 || process.platform === 'win32') usage();

const tmux = process.env.AGY_AUTH_TMUX_BIN || 'tmux';
const session = `agygram-auth-${randomUUID().replaceAll('-', '')}`;
// `agy --print` takes a separate non-interactive OAuth path that hard-limits
// code entry to 30 seconds, even inside a TTY. Keep safe execution options
// (such as --mode), but deliberately remove print-mode controls here.
const interactiveArgs = [];
for (let index = 0; index < agyArgs.length; index += 1) {
  if (agyArgs[index] === '--print' || agyArgs[index] === '--prompt' || agyArgs[index] === '--print-timeout') {
    index += 1;
    continue;
  }
  interactiveArgs.push(agyArgs[index]);
}
const command = [agyBin, ...interactiveArgs].map(quote).join(' ');
let lastOutput = '';
let ended = false;
let sawFailure = false;
let pollTimer = null;
let automation = Promise.resolve();
const completedStages = new Set();

async function tmuxCommand(args, options = {}) {
  return execFileAsync(tmux, args, {
    cwd,
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 512 * 1024,
    ...options,
  });
}

async function killSession() {
  try {
    await tmuxCommand(['kill-session', '-t', session]);
  } catch {
    // A naturally-completed session is already gone.
  }
}

async function finish(code) {
  if (ended) return;
  ended = true;
  clearInterval(pollTimer);
  await killSession();
  if (code === 0 && !sawFailure) {
    process.stdout.write('OAuth 완료 후 headless agy 요청으로 인증을 확인하는 중입니다...\n');
    code = await verifyAuthentication() ? 0 : 1;
  }
  process.exitCode = code;
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function automate(stage, keys) {
  if (completedStages.has(stage) || ended) return;
  completedStages.add(stage);
  automation = automation.then(async () => {
    for (const key of keys) {
      if (ended) return;
      await tmuxCommand(['send-keys', '-t', session, key]);
      await pause(120);
    }
  }).catch((error) => {
    sawFailure = true;
    process.stderr.write(`OAuth TTY automation failed: ${error.message}\n`);
    killSession().catch(() => {});
  });
}

function verifyAuthentication() {
  return new Promise((resolve) => {
    const child = spawn(agyBin, [
      '--mode', 'plan', '--print-timeout', '60s', '--print',
      'Reply with exactly AGY_AUTH_OK. Do not use tools or modify files.',
    ], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let output = '';
    let timedOut = false;
    const append = (chunk) => {
      output = `${output}${chunk}`.slice(-32 * 1024);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 65_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      const verified = !timedOut && exitCode === 0 && /\bAGY_AUTH_OK\b/.test(output);
      process.stdout.write(verified
        ? 'AGY_AUTH_OK\n'
        : '인증 확인 요청이 실패했습니다. /auth 를 다시 실행하세요.\n');
      resolve(verified);
    });
  });
}

async function poll() {
  if (ended) return;
  try {
    const { stdout } = await tmuxCommand(['capture-pane', '-p', '-J', '-t', session, '-S', '-200']);
    const output = String(stdout || '').trim();
    if (output && output !== lastOutput) {
      lastOutput = output;
      if (/authentication (?:failed|timed out)|oauth setup failed|invalid authorization/i.test(output)) {
        sawFailure = true;
      }
      process.stdout.write(`${output}\n`);
      if (/select login method/i.test(output)) automate('login-method', ['Enter']);
      if (/choose your color scheme/i.test(output)) automate('color-scheme', ['Enter']);
      // The default consent screen opts into interaction-data collection. Keep
      // that optional analytics checkbox off, then accept the displayed terms.
      if (/terms of service & data use/i.test(output)) {
        automate('terms', ['Enter', 'Down', 'Right', 'Enter']);
      }
      if (/do you trust the contents of this project/i.test(output)) automate('workspace-trust', ['Enter']);
      if (/\? for shortcuts/.test(output) && /plan mode|code mode/i.test(output)) {
        // agy's command palette may autocomplete `/exit` rather than execute
        // it. Two Ctrl-C presses are its documented unambiguous clean exit.
        automate('exit', ['C-c', 'C-c']);
      }
    }
  } catch {
    await finish(sawFailure ? 1 : 0);
  }
}

process.stdin.setEncoding('utf8');
let pendingInput = '';
process.stdin.on('data', (chunk) => {
  pendingInput += chunk;
  const lines = pendingInput.split(/\r?\n/);
  pendingInput = lines.pop();
  for (const line of lines) {
    const code = line.replace(/[\r\n\0]/g, '').slice(0, 4096);
    if (ended) continue;
    if (!code) {
      tmuxCommand(['send-keys', '-t', session, 'Enter']).catch(() => {});
      continue;
    }
    tmuxCommand(['send-keys', '-t', session, '-l', code])
      .then(() => tmuxCommand(['send-keys', '-t', session, 'Enter']))
      .catch(() => {});
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    finish(1).finally(() => process.exit(1));
  });
}

try {
  await tmuxCommand([
    'new-session', '-d', '-s', session, '-x', '120', '-y', '32', '-c', cwd, '--', command,
  ]);
} catch (error) {
  console.error(`Unable to start tmux OAuth transport: ${error.message}`);
  process.exitCode = 1;
  process.exit();
}

pollTimer = setInterval(() => {
  poll().catch(() => finish(1));
}, 350);
poll().catch(() => finish(1));
