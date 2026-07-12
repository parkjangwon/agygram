#!/bin/sh

set -eu

PROGRAM_NAME=agygram
VERIFY_DIR=

fail() {
  printf '%s\n' "$PROGRAM_NAME uninstall: $*" >&2
  exit 1
}

cleanup() {
  status=$?
  trap - 0 HUP INT TERM
  if [ -n "$VERIFY_DIR" ] && [ -d "$VERIFY_DIR" ]; then
    rm -rf "$VERIFY_DIR" || printf '%s\n' "$PROGRAM_NAME uninstall: warning: could not remove verification files" >&2
  fi
  exit "$status"
}

trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

find_install_root_argument() {
  root_argument=
  root_argument_seen=false
  expect_root=false

  for argument in "$@"; do
    if [ "$expect_root" = true ]; then
      [ -n "$argument" ] || fail '--install-root requires a non-empty path'
      [ "$root_argument_seen" = false ] || fail '--install-root may only be specified once'
      root_argument=$argument
      root_argument_seen=true
      expect_root=false
      continue
    fi

    case "$argument" in
      --)
        fail '-- option delimiters are not supported'
        ;;
      --install-root)
        expect_root=true
        ;;
      --install-root=*)
        fail 'use --install-root <path>, without an equals sign'
        ;;
    esac
  done

  [ "$expect_root" = false ] || fail '--install-root requires a path'
}

if [ "$#" -eq 1 ] && { [ "$1" = --help ] || [ "$1" = -h ]; }; then
  printf '%s\n' \
    'Uninstall the managed agygram application.' \
    '' \
    'Usage:' \
    '  uninstall.sh [--install-root <absolute-path>]' \
    '' \
    'The bot configuration, runtime data, workspace, and credentials are preserved.'
  exit 0
fi
find_install_root_argument "$@"

if [ "$root_argument_seen" = true ]; then
  install_root=$root_argument
elif [ "${AGYGRAM_INSTALL_ROOT+x}" = x ]; then
  [ -n "$AGYGRAM_INSTALL_ROOT" ] || fail 'AGYGRAM_INSTALL_ROOT must not be empty'
  install_root=$AGYGRAM_INSTALL_ROOT
else
  [ -n "${HOME:-}" ] || fail 'HOME is required to locate the installation'
  case "$(uname -s 2>/dev/null || printf unknown)" in
    Darwin)
      install_root=$HOME/Library/Application\ Support/agygram/manager
      ;;
    *)
      if [ -n "${XDG_DATA_HOME:-}" ]; then
        install_root=$XDG_DATA_HOME/agygram/manager
      else
        install_root=$HOME/.local/share/agygram/manager
      fi
      ;;
  esac
fi

case "$install_root" in
  /*) ;;
  *) fail 'the install root must be an absolute path' ;;
esac
if printf '%s' "$install_root" | LC_ALL=C grep -q '[[:cntrl:]]'; then
  fail 'the install root contains control characters'
fi

current_file=$install_root/current

if [ ! -e "$install_root" ] && [ ! -L "$install_root" ]; then
  printf '%s\n' "$PROGRAM_NAME is not installed; nothing to remove."
  exit 0
fi

release_basename=
pointer_mode=missing
if [ -e "$current_file" ] || [ -L "$current_file" ]; then
  pointer_mode=current
  [ -f "$current_file" ] || fail "invalid current release pointer: $current_file"
  [ ! -L "$current_file" ] || fail "refusing a symbolic current release pointer: $current_file"
  current_size=$(LC_ALL=C wc -c < "$current_file" | tr -d '[:space:]')
  case "$current_size" in
    ''|*[!0-9]*) fail 'the current release pointer size is invalid' ;;
  esac
  [ "$current_size" -gt 0 ] && [ "$current_size" -le 256 ] || fail 'the current release pointer is malformed'

  extra_line=
  exec 3< "$current_file"
  IFS= read -r release_basename <&3 || fail 'the current release pointer must contain one newline-terminated line'
  if IFS= read -r extra_line <&3 || [ -n "$extra_line" ]; then
    exec 3<&-
    fail 'the current release pointer must contain exactly one line'
  fi
  exec 3<&-

  semver='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?'
  if ! printf '%s\n' "$release_basename" | LC_ALL=C grep -Eq "^v${semver}-[0-9a-f]{40}$"; then
    fail 'the current release pointer is malformed'
  fi
fi

node_bin=$(command -v node 2>/dev/null || true)
[ -n "$node_bin" ] || fail 'Node.js 22 or 24 is required to uninstall agygram'

node_major=$(NODE_OPTIONS= NODE_PATH= NODE_TLS_REJECT_UNAUTHORIZED=1 "$node_bin" -p "process.versions.node.split('.')[0]" 2>/dev/null || true)
case "$node_major" in
  22|24) ;;
  *) fail 'Node.js 22 or 24 is required to uninstall agygram' ;;
esac

umask 077
temp_base=${TMPDIR:-/tmp}
case "$temp_base" in
  /*) ;;
  *) fail 'TMPDIR must be an absolute path' ;;
esac
[ -d "$temp_base" ] || fail "temporary directory does not exist: $temp_base"
VERIFY_DIR=$(mktemp -d "${temp_base%/}/agygram-uninstall.XXXXXXXX") || fail 'could not create a private verification directory'
chmod 700 "$VERIFY_DIR" || fail 'could not protect the verification directory'
verifier=$VERIFY_DIR/verify.mjs
cat > "$verifier" <<'AGYGRAM_UNINSTALL_VERIFY'
import { createHash } from 'node:crypto';
import { chmod, lstat, open, realpath } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';

const OWNER = 'agygram-managed-installer';
const REPOSITORY = 'parkjangwon/agygram';
const PACKAGE = 'agygram';
const LEGACY_REPOSITORIES = new Set([REPOSITORY, 'parkjangwon/antigravity-telegram-cli']);
const LEGACY_PACKAGES = new Set([PACKAGE, 'antigravity-telegram-cli']);
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const [rootArgument, pointerMode, expectedRelease, verifiedCopy] = process.argv.slice(2);
const API_ORIGIN = 'https://api.github.com';
const MAX_API_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

function fail(message) {
  throw new Error(message);
}

function getJson(apiPath) {
  const url = new URL(apiPath, API_ORIGIN);
  if (url.protocol !== 'https:' || url.origin !== API_ORIGIN) fail('invalid GitHub API URL');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      if (error) reject(error);
      else resolve(value);
    };
    const request = https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'Accept-Encoding': 'identity',
        'User-Agent': 'agygram-uninstaller-bootstrap/0.3.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(new Error(`GitHub request failed with HTTP ${response.statusCode ?? 0}`));
        return;
      }
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > MAX_API_BYTES) response.destroy(new Error('GitHub response exceeded its size limit'));
        else chunks.push(chunk);
      });
      response.once('error', (error) => finish(error));
      response.once('end', () => {
        const declared = response.headers['content-length'];
        if (declared && Number(declared) !== length) {
          finish(new Error('GitHub response was truncated'));
          return;
        }
        try {
          finish(null, JSON.parse(Buffer.concat(chunks, length).toString('utf8')));
        } catch {
          finish(new Error('GitHub returned invalid JSON'));
        }
      });
    });
    request.setTimeout(20_000, () => request.destroy(new Error('GitHub request stalled')));
    request.once('error', (error) => finish(error));
    const overallTimer = setTimeout(() => request.destroy(new Error('GitHub request timed out')), REQUEST_TIMEOUT_MS);
  });
}

async function resolveTagCommit(tag) {
  const reference = await getJson(`/repos/parkjangwon/agygram/git/ref/tags/${encodeURIComponent(tag)}`);
  if (reference?.ref !== `refs/tags/${tag}` || !reference.object) fail('release tag reference is invalid');
  let object = reference.object;
  for (let depth = 0; depth < 5; depth++) {
    if (!COMMIT.test(object?.sha ?? '')) fail('release tag has an invalid object ID');
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag') fail('release tag does not resolve to a commit');
    const annotated = await getJson(`/repos/parkjangwon/agygram/git/tags/${object.sha}`);
    if (depth === 0 && annotated?.tag !== tag) fail('annotated release tag name did not match');
    object = annotated?.object;
  }
  fail('release tag indirection is too deep');
}

function samePath(left, right) {
  const normalize = (value) => {
    const result = path.normalize(value);
    return process.platform === 'win32' ? result.toLowerCase() : result;
  };
  return normalize(left) === normalize(right);
}

function assertIdentity(value, label) {
  if (!value || value.schemaVersion !== 1 || value.owner !== OWNER || !LEGACY_REPOSITORIES.has(value.repository)) {
    fail(`${label} identity is invalid`);
  }
}

function assertOwned(info, target) {
  if (process.platform !== 'win32' && process.getuid && info.uid !== process.getuid()) {
    fail(`managed path has an unexpected owner: ${target}`);
  }
}

async function assertDirectory(target, privateDirectory = false) {
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`managed directory is invalid: ${target}`);
  assertOwned(info, target);
  if (process.platform !== 'win32') {
    const forbidden = privateDirectory ? 0o077 : 0o022;
    if ((info.mode & forbidden) !== 0) fail(`managed directory permissions are unsafe: ${target}`);
  }
  const canonical = await realpath(target);
  if (!samePath(canonical, path.resolve(target))) fail(`managed directory is not canonical: ${target}`);
}

async function readRegular(target, maximumBytes, privateFile = false) {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumBytes) {
    fail(`managed file is invalid: ${target}`);
  }
  assertOwned(info, target);
  if (process.platform !== 'win32') {
    const forbidden = privateFile ? 0o077 : 0o022;
    if ((info.mode & forbidden) !== 0) fail(`managed file permissions are unsafe: ${target}`);
  }
  const handle = await open(target, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== info.size || opened.dev !== info.dev || opened.ino !== info.ino) {
      fail(`managed file changed while opening: ${target}`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size) fail(`managed file changed while reading: ${target}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readJson(target, maximumBytes, privateFile = false) {
  const bytes = await readRegular(target, maximumBytes, privateFile);
  try {
    const value = JSON.parse(utf8.decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('JSON receipt must be an object');
    return value;
  } catch (error) {
    fail(`managed JSON receipt is invalid: ${path.basename(target)} (${error.message})`);
  }
}

async function main() {
  if (!rootArgument || !path.isAbsolute(rootArgument) || !['current', 'missing'].includes(pointerMode) ||
      !verifiedCopy || !path.isAbsolute(verifiedCopy) || (pointerMode === 'missing' && expectedRelease !== '-')) {
    fail('invalid verifier arguments');
  }
  const root = path.resolve(rootArgument);
  await assertDirectory(root, true);

  const rootMarker = await readJson(path.join(root, '.agygram-managed-root.json'), 1024 * 1024, true);
  assertIdentity(rootMarker, 'install root marker');
  if (typeof rootMarker.installRoot !== 'string' || !samePath(rootMarker.installRoot, root)) {
    fail('install root marker does not match the selected root');
  }

  const manifest = await readJson(path.join(root, 'manifest.json'), 1024 * 1024, true);
  assertIdentity(manifest, 'manifest');
  if (!SEMVER.test(manifest.version ?? '') || !COMMIT.test(manifest.commit ?? '')) {
    fail('manifest release identity is invalid');
  }
  const releaseName = `v${manifest.version}-${manifest.commit}`;
  if (manifest.tag !== `v${manifest.version}` || manifest.currentRelease !== releaseName ||
      (pointerMode === 'current' && expectedRelease !== releaseName)) {
    fail('manifest, current pointer, and requested release do not match');
  }

  if (typeof manifest.serviceInstalled !== 'boolean') fail('manifest service state is invalid');

  const currentPath = path.join(root, 'current');
  if (pointerMode === 'current') {
    const currentBytes = await readRegular(currentPath, 256, true);
    if (!currentBytes.equals(Buffer.from(`${releaseName}\n`, 'utf8'))) fail('current pointer contents are invalid');
  } else {
    try {
      await lstat(currentPath);
      fail('current pointer appeared during recovery; retry the uninstall');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const releases = path.join(root, 'releases');
  const releaseDirectory = path.join(releases, releaseName);
  await assertDirectory(releases, true);
  await assertDirectory(releaseDirectory, true);

  const releaseMarker = await readJson(path.join(releaseDirectory, '.agygram-release.json'), 1024 * 1024, true);
  assertIdentity(releaseMarker, 'release marker');
  if (releaseMarker.version !== manifest.version || releaseMarker.tag !== manifest.tag ||
      releaseMarker.commit !== manifest.commit || releaseMarker.releaseName !== releaseName ||
      !SHA256.test(releaseMarker.archiveSha256 ?? '')) {
    fail('release marker does not match the manifest');
  }

  const packageJson = await readJson(path.join(releaseDirectory, 'package.json'), 256 * 1024);
  if (!LEGACY_PACKAGES.has(packageJson.name) || packageJson.version !== manifest.version) {
    fail('installed package identity does not match the manifest');
  }

  const uninstallerBytes = await readRegular(
    path.join(releaseDirectory, 'scripts', 'uninstall.mjs'),
    4 * 1024 * 1024,
  );
  const inventory = await readJson(
    path.join(releaseDirectory, '.agygram-release-inventory.json'),
    16 * 1024 * 1024,
    true,
  );
  assertIdentity(inventory, 'release inventory');
  if (!Array.isArray(inventory.records) || inventory.records.length > 50_000) {
    fail('release inventory records are invalid');
  }
  const uninstallerRecords = inventory.records.filter(
    (record) => record?.path === 'scripts/uninstall.mjs',
  );
  const inventoryDigest = createHash('sha256').update(uninstallerBytes).digest('hex');
  if (uninstallerRecords.length !== 1 || uninstallerRecords[0].type !== 'file' ||
      uninstallerRecords[0].size !== uninstallerBytes.length ||
      uninstallerRecords[0].sha256 !== inventoryDigest) {
    fail('installed uninstaller does not match the installer inventory');
  }
  const release = await getJson(
    `/repos/parkjangwon/agygram/releases/tags/${encodeURIComponent(manifest.tag)}`,
  );
  if (release?.tag_name !== manifest.tag || release.draft !== false ||
      release.prerelease !== false || release.immutable !== true) {
    fail('installed version is not an immutable stable GitHub release');
  }
  const assets = Array.isArray(release.assets)
    ? release.assets.filter((asset) => asset?.name === 'uninstall.mjs')
    : [];
  if (assets.length !== 1 || assets[0].state !== 'uploaded' || assets[0].size !== uninstallerBytes.length) {
    fail('immutable release uninstall asset metadata is invalid');
  }
  const expectedDigest = /^sha256:([0-9a-f]{64})$/i.exec(assets[0].digest ?? '')?.[1]?.toLowerCase();
  if (!expectedDigest || inventoryDigest !== expectedDigest) fail('installed uninstaller digest verification failed');
  if ((await resolveTagCommit(manifest.tag)).toLowerCase() !== manifest.commit) {
    fail('immutable release tag does not match the installed commit');
  }

  const copyHandle = await open(verifiedCopy, 'wx', 0o700);
  try {
    await copyHandle.writeFile(uninstallerBytes);
    await copyHandle.sync();
  } finally {
    await copyHandle.close();
  }
  if (process.platform !== 'win32') await chmod(verifiedCopy, 0o700);
  process.stdout.write(releaseName);
}

main().catch((error) => {
  process.stderr.write(`agygram uninstall: local installation verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
AGYGRAM_UNINSTALL_VERIFY
chmod 600 "$verifier" || fail 'could not protect the local installation verifier'
NODE_OPTIONS= NODE_PATH= NODE_TLS_REJECT_UNAUTHORIZED=1 "$node_bin" --check -- "$verifier"
verified_uninstaller=$VERIFY_DIR/uninstall.mjs
verifier_expected=$release_basename
if [ "$pointer_mode" = missing ]; then
  verifier_expected=-
fi
release_basename=$(NODE_OPTIONS= NODE_PATH= NODE_TLS_REJECT_UNAUTHORIZED=1 "$node_bin" -- "$verifier" "$install_root" "$pointer_mode" "$verifier_expected" "$verified_uninstaller")

semver='(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?'
if ! printf '%s\n' "$release_basename" | LC_ALL=C grep -Eq "^v${semver}-[0-9a-f]{40}$"; then
  fail 'the verified release name is malformed'
fi
release_dir=$install_root/releases/$release_basename
local_uninstaller=$release_dir/scripts/uninstall.mjs
uninstaller=$verified_uninstaller
[ -d "$release_dir" ] || fail "installed release is missing: $release_basename"
[ ! -L "$release_dir" ] || fail 'refusing a symbolic installed release directory'
[ -f "$local_uninstaller" ] || fail "installed uninstaller is missing: $local_uninstaller"
[ ! -L "$local_uninstaller" ] || fail 'refusing a symbolic installed uninstaller'
[ -f "$uninstaller" ] || fail 'verified private uninstaller copy is missing'

if [ "$root_argument_seen" = true ]; then
  NODE_OPTIONS= NODE_PATH= NODE_TLS_REJECT_UNAUTHORIZED=1 "$node_bin" -- "$uninstaller" "$@"
else
  NODE_OPTIONS= NODE_PATH= NODE_TLS_REJECT_UNAUTHORIZED=1 "$node_bin" -- "$uninstaller" --install-root "$install_root" "$@"
fi
