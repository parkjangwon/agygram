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
let loginMethodSelected = false;

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
  process.exitCode = code;
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
      if (!loginMethodSelected && /select login method/i.test(output)) {
        loginMethodSelected = true;
        tmuxCommand(['send-keys', '-t', session, 'Enter']).catch(() => {});
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

const pollTimer = setInterval(() => {
  poll().catch(() => finish(1));
}, 350);
poll().catch(() => finish(1));
