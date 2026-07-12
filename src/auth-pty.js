import { spawn } from 'node:child_process';

const separator = process.argv.indexOf('--');
if (separator < 3) throw new Error('Usage: auth-pty.js <agy-bin> <cwd> -- <agy arguments>');
const [agyBin, cwd] = process.argv.slice(2, separator);
const originalArgs = process.argv.slice(separator + 1);
if (!agyBin || !cwd || originalArgs.length === 0) throw new Error('Invalid PTY OAuth arguments');

const pty = await import('@homebridge/node-pty-prebuilt-multiarch');
const args = [];
for (let index = 0; index < originalArgs.length; index += 1) {
  if (['--print', '--prompt', '--print-timeout'].includes(originalArgs[index])) index += 1;
  else args.push(originalArgs[index]);
}
let child;
let ended = false;
let failed = false;
let screen = '';
let timer = null;
const stages = new Set();
let chain = Promise.resolve();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function output() { timer = null; if (screen) process.stdout.write(`${screen}\n`); }
function automate(stage, keys) {
  if (stages.has(stage) || ended) return;
  stages.add(stage);
  chain = chain.then(async () => { for (const key of keys) { if (ended) return; child.write(key); await sleep(120); } })
    .catch(() => { failed = true; child.kill(); });
}
function inspect() {
  if (/authentication (?:failed|timed out)|oauth setup failed|invalid authorization/i.test(screen)) failed = true;
  if (/select login method/i.test(screen)) automate('login', ['\r']);
  if (/choose your color scheme/i.test(screen)) automate('theme', ['\r']);
  if (/terms of service & data use/i.test(screen)) automate('terms', ['\r', '\x1b[B', '\x1b[C', '\r']);
  if (/do you trust the contents of this project/i.test(screen)) automate('trust', ['\r']);
  if (/\? for shortcuts/.test(screen) && /plan mode|code mode/i.test(screen)) automate('exit', ['\x03', '\x03']);
}
function verify() {
  return new Promise((resolve) => {
    const probe = spawn(agyBin, ['--mode', 'plan', '--print-timeout', '60s', '--print', 'Reply with exactly AGY_AUTH_OK. Do not use tools or modify files.'], { cwd, env: process.env, shell: false, windowsHide: true });
    let text = '';
    const deadline = setTimeout(() => probe.kill(), 65_000);
    probe.stdout.on('data', (chunk) => { text = `${text}${chunk}`.slice(-32768); });
    probe.stderr.on('data', (chunk) => { text = `${text}${chunk}`.slice(-32768); });
    probe.once('error', () => { clearTimeout(deadline); resolve(false); });
    probe.once('close', (code) => { clearTimeout(deadline); resolve(code === 0 && /\bAGY_AUTH_OK\b/.test(text)); });
  });
}
async function finish(code, shouldVerify = true) {
  if (ended) return;
  ended = true;
  clearTimeout(timer);
  const ok = code === 0 && !failed && shouldVerify && await verify();
  process.stdout.write(ok ? 'AGY_AUTH_OK\n' : '인증 확인 요청이 실패했습니다. /auth 를 다시 실행하세요.\n');
  process.exitCode = ok ? 0 : 1;
}
child = pty.spawn(agyBin, args, { name: 'xterm-256color', cols: 120, rows: 32, cwd, env: { ...process.env, TERM: 'xterm-256color' } });
child.onData((chunk) => {
  screen = `${screen}${chunk}`.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '').slice(-20000);
  inspect();
  if (!timer) timer = setTimeout(output, 300);
});
child.onExit(({ exitCode }) => finish(exitCode));
process.stdin.setEncoding('utf8');
let pending = '';
process.stdin.on('data', (chunk) => {
  pending += chunk;
  const lines = pending.split(/\r?\n/);
  pending = lines.pop();
  for (const line of lines) child.write(`${line.replace(/[\r\n\0]/g, '').slice(0, 4096)}\r`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { child.kill(); finish(1, false); });
