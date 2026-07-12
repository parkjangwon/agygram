#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  createReadStream,
} from 'node:fs';
import {
  chmod,
  lstat,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 1;
const OWNER = 'agygram-managed-installer';
const REPOSITORY = 'parkjangwon/agygram';
const LEGACY_REPOSITORIES = new Set([REPOSITORY, 'parkjangwon/antigravity-telegram-cli']);
const PACKAGE_NAME = 'agygram';
const LEGACY_PACKAGE_NAMES = new Set([PACKAGE_NAME, 'antigravity-telegram-cli']);
const ROOT_MARKER_NAME = '.agygram-managed-root.json';
const RELEASE_MARKER_NAME = '.agygram-release.json';
const RELEASE_INVENTORY_NAME = '.agygram-release-inventory.json';
const MANIFEST_NAME = 'manifest.json';
const CURRENT_NAME = 'current';
const LOCK_NAME = '.install.lock';
const TRANSACTION_NAME = 'transaction.json';
const UNINSTALL_RECEIPT_NAME = '.agygram-uninstall.json';
const MAX_JSON_BYTES = 1024 * 1024;
const SERVICE_TIMEOUT_MS = 180_000;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

const USAGE = `Uninstall the managed agygram application.

Usage:
  node uninstall.mjs [--install-root <absolute-path>]

Options:
  --install-root <path>  Managed installation root to remove
  -h, --help             Show this help

The bot configuration, runtime data, workspace, Antigravity credentials,
system keyring entries, and Linux linger setting are always preserved.
`;

function fail(message) {
  throw new Error(message);
}

function isKnownRepository(value) {
  return LEGACY_REPOSITORIES.has(value);
}

function isKnownPackageName(value) {
  return LEGACY_PACKAGE_NAMES.has(value);
}

function assertTestDependencies(dependencies) {
  const injected = Object.keys(dependencies).filter((key) => key !== 'testMode');
  if (
    injected.length > 0 &&
    dependencies.testMode !== true &&
    process.env.AGYGRAM_TEST_MODE !== '1'
  ) {
    fail('dependency injection is available only when AGYGRAM_TEST_MODE=1');
  }
}

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function samePath(left, right, platform = process.platform) {
  const pathApi = pathApiFor(platform);
  const normalize = (value) => {
    let result = pathApi.normalize(value);
    while (result.length > pathApi.parse(result).root.length && /[\\/]$/u.test(result)) {
      result = result.slice(0, -1);
    }
    return platform === 'win32' ? result.toLowerCase() : result;
  };
  return normalize(left) === normalize(right);
}

function isAbsolutePath(value, platform = process.platform) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  return platform === 'win32'
    ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u.test(value)
    : path.posix.isAbsolute(value);
}

function assertAbsolutePath(value, label, platform = process.platform) {
  if (!isAbsolutePath(value, platform)) fail(`${label} must be an absolute path`);
}

function isWithin(parent, candidate, platform = process.platform) {
  const pathApi = pathApiFor(platform);
  const relative = pathApi.relative(parent, candidate);
  if (relative === '') return true;
  if (relative === '..' || relative.startsWith(`..${pathApi.sep}`)) return false;
  return !pathApi.isAbsolute(relative);
}

function validateHome(homeDir, platform) {
  assertAbsolutePath(homeDir, 'home directory', platform);
  const pathApi = pathApiFor(platform);
  const resolved = pathApi.resolve(homeDir);
  if (samePath(resolved, pathApi.parse(resolved).root, platform)) {
    fail('home directory cannot be a filesystem root');
  }
  return resolved;
}

function platformDefaults({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const pathApi = pathApiFor(platform);
  const home = validateHome(homeDir, platform);
  let installRoot;
  let configFile;
  let dataDir;
  let workspaceDir;

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || pathApi.join(home, 'AppData', 'Local');
    assertAbsolutePath(localAppData, 'LOCALAPPDATA', platform);
    const base = pathApi.join(localAppData, 'agygram');
    installRoot = pathApi.join(base, 'manager');
    configFile = pathApi.join(base, 'config', '.env');
    dataDir = pathApi.join(base, 'data');
    workspaceDir = pathApi.join(base, 'workspace');
  } else if (platform === 'darwin') {
    const base = pathApi.join(home, 'Library', 'Application Support', 'agygram');
    installRoot = pathApi.join(base, 'manager');
    configFile = pathApi.join(base, 'config', '.env');
    dataDir = pathApi.join(base, 'data');
    workspaceDir = pathApi.join(base, 'workspace');
  } else if (platform === 'linux') {
    const dataHome = env.XDG_DATA_HOME || pathApi.join(home, '.local', 'share');
    const configHome = env.XDG_CONFIG_HOME || pathApi.join(home, '.config');
    assertAbsolutePath(dataHome, 'XDG_DATA_HOME', platform);
    assertAbsolutePath(configHome, 'XDG_CONFIG_HOME', platform);
    const dataBase = pathApi.join(dataHome, 'agygram');
    installRoot = pathApi.join(dataBase, 'manager');
    configFile = pathApi.join(configHome, 'agygram', '.env');
    dataDir = pathApi.join(dataBase, 'data');
    workspaceDir = pathApi.join(dataBase, 'workspace');
  } else {
    fail(`unsupported operating system: ${platform}`);
  }

  return {
    homeDir: home,
    installRoot: pathApi.resolve(installRoot),
    configFile: pathApi.resolve(configFile),
    dataDir: pathApi.resolve(dataDir),
    workspaceDir: pathApi.resolve(workspaceDir),
  };
}

function parseArguments(argv, defaults, platform = process.platform) {
  const result = { installRoot: defaults?.installRoot, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '-h' || option === '--help') {
      if (argv.length !== 1) fail(`${option} cannot be combined with other options`);
      result.help = true;
      continue;
    }
    if (option !== '--install-root') fail(`unknown option: ${option}`);
    if (seen.has(option)) fail(`duplicate option: ${option}`);
    seen.add(option);
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) fail(`missing value after ${option}`);
    index += 1;
    assertAbsolutePath(value, 'install root', platform);
    result.installRoot = pathApiFor(platform).resolve(value);
  }
  return result;
}

function environmentInstallRoot(env, platform) {
  if (!Object.hasOwn(env, 'AGYGRAM_INSTALL_ROOT')) return undefined;
  const value = env.AGYGRAM_INSTALL_ROOT;
  assertAbsolutePath(value, 'AGYGRAM_INSTALL_ROOT', platform);
  return pathApiFor(platform).resolve(value);
}

function assertSafeInstallRoot(installRoot, homeDir, platform = process.platform) {
  assertAbsolutePath(installRoot, 'install root', platform);
  const pathApi = pathApiFor(platform);
  const resolved = pathApi.resolve(installRoot);
  if (samePath(resolved, pathApi.parse(resolved).root, platform)) {
    fail('refusing to use a filesystem root as the install root');
  }
  if (samePath(resolved, homeDir, platform)) {
    fail('refusing to use the home directory as the install root');
  }
  return resolved;
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertPosixOwner(info, target, expectedUid) {
  if (expectedUid == null || process.platform === 'win32') return;
  if (info.uid !== expectedUid) fail(`managed path has an unexpected owner: ${target}`);
}

async function assertDirectory(target, {
  privateDirectory = false,
  expectedUid,
  platform = process.platform,
  canonical = true,
} = {}) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail(`managed directory is not a regular directory: ${target}`);
  }
  assertPosixOwner(info, target, expectedUid);
  if (platform !== 'win32') {
    const forbidden = privateDirectory ? 0o077 : 0o022;
    if ((info.mode & forbidden) !== 0) {
      fail(`managed directory permissions are unsafe: ${target}`);
    }
  }
  if (canonical) {
    const actual = await realpath(target);
    if (!samePath(actual, pathApiFor(platform).resolve(target), platform)) {
      fail(`managed directory resolves through a symlink or reparse point: ${target}`);
    }
  }
  return info;
}

async function assertRegularFile(target, {
  privateFile = false,
  expectedUid,
  platform = process.platform,
} = {}) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) {
    fail(`managed file is not a regular file: ${target}`);
  }
  assertPosixOwner(info, target, expectedUid);
  if (platform !== 'win32') {
    const forbidden = privateFile ? 0o077 : 0o022;
    if ((info.mode & forbidden) !== 0) fail(`managed file permissions are unsafe: ${target}`);
  }
  return info;
}

async function readSmallFile(target, limit = MAX_JSON_BYTES) {
  const info = await stat(target);
  if (info.size > limit) fail(`managed file is unexpectedly large: ${target}`);
  return readFile(target);
}

async function readPrivateJson(target, options = {}) {
  await assertRegularFile(target, { ...options, privateFile: true });
  const body = await readSmallFile(target, options.maxBytes ?? MAX_JSON_BYTES);
  if (body.length === 0) fail(`managed JSON file is empty: ${target}`);
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    fail(`managed JSON file is invalid: ${target}`);
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`managed JSON file must contain an object: ${target}`);
  }
  return value;
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be an ISO timestamp`);
  }
}

function isStrictSemver(value) {
  if (typeof value !== 'string' || !SEMVER.test(value)) return false;
  const withoutBuild = value.split('+', 1)[0];
  const dash = withoutBuild.indexOf('-');
  if (dash < 0) return true;
  return withoutBuild
    .slice(dash + 1)
    .split('.')
    .every((identifier) => !/^\d+$/u.test(identifier) || identifier === '0' || !identifier.startsWith('0'));
}

function validateRootMarker(marker, installRoot, platform = process.platform) {
  if (marker.schemaVersion !== SCHEMA_VERSION || marker.owner !== OWNER) {
    fail('install root is not owned by the agygram managed installer');
  }
  if (!isKnownRepository(marker.repository)) fail('install root repository receipt is invalid');
  assertAbsolutePath(marker.installRoot, 'root marker installRoot', platform);
  if (!samePath(marker.installRoot, installRoot, platform)) {
    fail('root marker does not match the selected install root');
  }
  assertTimestamp(marker.createdAt, 'root marker createdAt');
}

function validateReleaseName(name, label = 'release name') {
  if (
    typeof name !== 'string' ||
    name.length > 180 ||
    name === '.' ||
    name === '..' ||
    !/^[A-Za-z0-9._+-]+$/u.test(name)
  ) {
    fail(`${label} is invalid`);
  }
  return name;
}

function expectedReleaseName(version, commit) {
  return `v${version}-${commit}`;
}

function validateManifest(manifest, {
  installRoot,
  defaults,
  platform = process.platform,
} = {}) {
  if (manifest.schemaVersion !== SCHEMA_VERSION) fail('unsupported manifest schemaVersion');
  if (manifest.owner !== OWNER) fail('manifest owner is invalid');
  if (!isKnownRepository(manifest.repository)) fail('manifest repository is invalid');
  if (!isStrictSemver(manifest.version)) {
    fail('manifest version is invalid');
  }
  if (typeof manifest.commit !== 'string' || !COMMIT.test(manifest.commit)) {
    fail('manifest commit is invalid');
  }
  if (manifest.tag != null && manifest.tag !== `v${manifest.version}`) {
    fail('manifest tag does not match version');
  }
  validateReleaseName(manifest.currentRelease, 'manifest currentRelease');
  if (manifest.currentRelease !== expectedReleaseName(manifest.version, manifest.commit)) {
    fail('manifest currentRelease does not match version and commit');
  }
  if (manifest.previousRelease != null) {
    validateReleaseName(manifest.previousRelease, 'manifest previousRelease');
    if (manifest.previousRelease === manifest.currentRelease) {
      fail('manifest previousRelease duplicates currentRelease');
    }
  }
  for (const field of ['configFile', 'dataDir', 'workspaceDir']) {
    assertAbsolutePath(manifest[field], `manifest ${field}`, platform);
    if (
      isWithin(installRoot, manifest[field], platform) ||
      isWithin(manifest[field], installRoot, platform)
    ) {
      fail(`manifest ${field} must remain outside the managed install root`);
    }
    const pathApi = pathApiFor(platform);
    if (
      samePath(manifest[field], pathApi.parse(manifest[field]).root, platform) ||
      samePath(manifest[field], defaults.homeDir, platform)
    ) {
      fail(`manifest ${field} points at a protected filesystem location`);
    }
  }
  if (typeof manifest.serviceInstalled !== 'boolean') {
    fail('manifest serviceInstalled must be boolean');
  }
  if (manifest.configSha256 != null && !SHA256.test(manifest.configSha256)) {
    fail('manifest configSha256 is invalid');
  }
  // Early schema-v1 installers did not persist this field. An absent receipt
  // inherits the current process environment; a present null value explicitly
  // means the platform default and must clear ambient XDG_CONFIG_HOME.
  if (manifest.serviceEnvironment == null) manifest.serviceEnvironment = {};
  if (
    typeof manifest.serviceEnvironment !== 'object' ||
    Array.isArray(manifest.serviceEnvironment)
  ) fail('manifest serviceEnvironment receipt is invalid');
  const xdgConfigHome = manifest.serviceEnvironment.xdgConfigHome;
  if (xdgConfigHome != null) {
    assertAbsolutePath(xdgConfigHome, 'manifest serviceEnvironment.xdgConfigHome', platform);
    const pathApi = pathApiFor(platform);
    if (
      samePath(xdgConfigHome, pathApi.parse(xdgConfigHome).root, platform) ||
      isWithin(installRoot, xdgConfigHome, platform)
    ) {
      fail('manifest serviceEnvironment.xdgConfigHome points at an unsafe location');
    }
  }
  if (platform !== 'linux' && xdgConfigHome != null) {
    fail('manifest serviceEnvironment.xdgConfigHome is only valid on Linux');
  }
  if (manifest.launcher == null || typeof manifest.launcher !== 'object') {
    fail('manifest launcher receipt is missing');
  }
  assertTimestamp(manifest.installedAt, 'manifest installedAt');
  assertTimestamp(manifest.updatedAt, 'manifest updatedAt');
  return manifest;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value != null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameManifest(left, right) {
  return stableJson(left) === stableJson(right);
}

function validateTransaction(transaction, context) {
  if (
    transaction.schemaVersion !== SCHEMA_VERSION ||
    transaction.owner !== OWNER ||
    !isKnownRepository(transaction.repository)
  ) {
    fail('managed installer transaction receipt is invalid');
  }
  if (!['prepared', 'old-service-stopped', 'state-written', 'new-service-started'].includes(transaction.phase)) {
    fail('managed installer transaction phase is invalid');
  }
  if (transaction.previousManifest != null) {
    validateManifest(transaction.previousManifest, context);
  }
  validateManifest(transaction.targetManifest, context);
  if (typeof transaction.previousServiceActive !== 'boolean') {
    fail('managed installer transaction previousServiceActive is invalid');
  }
  if (transaction.previousServiceActive && transaction.previousManifest == null) {
    fail('managed installer transaction has no previous service receipt');
  }
  const rollback = transaction.configRollback;
  if (
    rollback == null ||
    typeof rollback !== 'object' ||
    rollback.path !== transaction.targetManifest.configFile ||
    typeof rollback.existed !== 'boolean' ||
    !SHA256.test(rollback.afterSha256 || '')
  ) {
    fail('managed installer transaction configuration receipt is invalid');
  }
  if (rollback.existed) {
    if (typeof rollback.beforeBase64 !== 'string') {
      fail('managed installer transaction configuration backup is invalid');
    }
    const before = Buffer.from(rollback.beforeBase64, 'base64');
    if (
      before.length > MAX_JSON_BYTES ||
      before.toString('base64') !== rollback.beforeBase64
    ) {
      fail('managed installer transaction configuration backup is invalid');
    }
  } else if (rollback.beforeBase64 != null) {
    fail('managed installer transaction has an unexpected configuration backup');
  }
  assertTimestamp(transaction.createdAt, 'transaction createdAt');
  assertTimestamp(transaction.updatedAt, 'transaction updatedAt');
  return transaction;
}

function validateReleaseMarker(marker, releaseName, expectedCurrent) {
  if (marker.schemaVersion !== SCHEMA_VERSION) fail(`unsupported release marker: ${releaseName}`);
  if (marker.owner !== OWNER) fail(`release owner is invalid: ${releaseName}`);
  if (!isKnownRepository(marker.repository)) fail(`release repository is invalid: ${releaseName}`);
  if (!isStrictSemver(marker.version)) {
    fail(`release version is invalid: ${releaseName}`);
  }
  if (typeof marker.commit !== 'string' || !COMMIT.test(marker.commit)) {
    fail(`release commit is invalid: ${releaseName}`);
  }
  if (marker.tag != null && marker.tag !== `v${marker.version}`) {
    fail(`release tag does not match version: ${releaseName}`);
  }
  if (marker.releaseName !== releaseName) fail(`release marker name mismatch: ${releaseName}`);
  if (expectedReleaseName(marker.version, marker.commit) !== releaseName) {
    fail(`release directory name mismatch: ${releaseName}`);
  }
  assertTimestamp(marker.installedAt, `release installedAt (${releaseName})`);
  if (expectedCurrent) {
    if (marker.version !== expectedCurrent.version || marker.commit !== expectedCurrent.commit) {
      fail('current release marker does not match the manifest');
    }
  }
  return marker;
}

function validateUninstallReceipt(receipt, manifest) {
  if (
    receipt.schemaVersion !== SCHEMA_VERSION ||
    receipt.owner !== OWNER ||
    !isKnownRepository(receipt.repository) ||
    receipt.serviceAbsent !== true ||
    !isStrictSemver(receipt.version) ||
    !COMMIT.test(receipt.commit || '') ||
    receipt.currentRelease !== expectedReleaseName(receipt.version, receipt.commit)
  ) {
    fail('managed uninstall receipt is invalid');
  }
  assertTimestamp(receipt.createdAt, 'uninstall receipt createdAt');
  if (
    manifest &&
    (
      receipt.version !== manifest.version ||
      receipt.commit !== manifest.commit ||
      receipt.currentRelease !== manifest.currentRelease
    )
  ) {
    fail('managed uninstall receipt does not match the manifest');
  }
  return receipt;
}

async function auditManagedTree(root, { expectedUid, platform }) {
  const pending = [root];
  while (pending.length > 0) {
    const target = pending.pop();
    const info = await lstat(target);
    assertPosixOwner(info, target, expectedUid);
    if (info.isSymbolicLink()) {
      const pathApi = pathApiFor(platform);
      const parent = pathApi.dirname(target);
      const npmBin = pathApi.basename(parent) === '.bin' &&
        pathApi.basename(pathApi.dirname(parent)) === 'node_modules';
      const link = await readlink(target);
      const resolved = await realpath(target);
      const resolvedInfo = await stat(resolved);
      if (
        platform === 'win32' ||
        !npmBin ||
        pathApi.isAbsolute(link) ||
        !isWithin(pathApi.join(root, 'node_modules'), resolved, platform) ||
        !resolvedInfo.isFile()
      ) {
        fail(`managed release contains a symlink or reparse point: ${target}`);
      }
      continue;
    }
    if (platform !== 'win32' && (info.mode & 0o022) !== 0) {
      fail(`managed release is writable by another user or group: ${target}`);
    }
    if (info.isDirectory()) {
      const actual = await realpath(target);
      if (!isWithin(root, actual, platform)) fail(`managed release escapes its directory: ${target}`);
      const entries = await readdir(target, { withFileTypes: true });
      for (const entry of entries) pending.push(path.join(target, entry.name));
    } else if (!info.isFile()) {
      fail(`managed release contains an unsupported filesystem object: ${target}`);
    }
  }
}

function normalizeRepository(value) {
  const raw = typeof value === 'string' ? value : value?.url;
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/^git\+/u, '')
    .replace(/^https:\/\/github\.com\//u, '')
    .replace(/^git@github\.com:/u, '')
    .replace(/\.git$/u, '')
    .replace(/\/$/u, '');
}

async function validateReleaseDirectory(releaseRoot, releaseName, {
  manifest,
  expectedUid,
  platform,
  current = false,
  auditTree = true,
} = {}) {
  await assertDirectory(releaseRoot, { expectedUid, platform });
  const markerPath = path.join(releaseRoot, RELEASE_MARKER_NAME);
  const marker = await readPrivateJson(markerPath, { expectedUid, platform });
  validateReleaseMarker(marker, releaseName, current ? manifest : undefined);
  await verifyReleaseInventory(releaseRoot, {
    expectedUid,
    platform,
    required: current && Object.hasOwn(manifest, 'configSha256'),
  });
  if (auditTree) await auditManagedTree(releaseRoot, { expectedUid, platform });

  if (current) {
    const packagePath = path.join(releaseRoot, 'package.json');
    await assertRegularFile(packagePath, { expectedUid, platform });
    const body = await readSmallFile(packagePath);
    let packageJson;
    try {
      packageJson = JSON.parse(body.toString('utf8'));
    } catch {
      fail('current release package.json is invalid');
    }
    if (packageJson == null || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
      fail('current release package.json must contain an object');
    }
    if (
      !isKnownPackageName(packageJson.name) ||
      packageJson.version !== manifest.version ||
      !isKnownRepository(normalizeRepository(packageJson.repository))
    ) {
      fail('current release package identity does not match the manifest');
    }
    await assertRegularFile(path.join(releaseRoot, 'bin', 'agygram.js'), {
      expectedUid,
      platform,
    });
  }
  return marker;
}

async function sha256File(target) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = createReadStream(target);
    input.once('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('end', resolve);
  });
  return hash.digest('hex');
}

async function buildReleaseInventory(root, platform = process.platform) {
  const records = [];
  const pending = [''];
  let totalBytes = 0;
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const directory = relativeDirectory
      ? path.join(root, ...relativeDirectory.split('/'))
      : root;
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (relative === RELEASE_MARKER_NAME || relative === RELEASE_INVENTORY_NAME) continue;
      const target = path.join(directory, name);
      const info = await lstat(target);
      if (info.isDirectory()) {
        records.push({ path: relative, type: 'directory' });
        pending.push(relative);
      } else if (info.isFile()) {
        totalBytes += info.size;
        records.push({
          path: relative,
          type: 'file',
          size: info.size,
          sha256: await sha256File(target),
        });
      } else if (info.isSymbolicLink()) {
        if (!relative.startsWith('node_modules/.bin/')) {
          fail(`managed release contains an unexpected symlink: ${relative}`);
        }
        const targetText = await readlink(target);
        const resolved = path.resolve(path.dirname(target), targetText);
        if (!isWithin(root, resolved, platform) || samePath(root, resolved, platform)) {
          fail(`managed release symlink escapes its release: ${relative}`);
        }
        records.push({ path: relative, type: 'symlink', target: targetText });
      } else {
        fail(`managed release has an unsupported filesystem object: ${relative}`);
      }
      if (records.length > 50_000 || totalBytes > 512 * 1024 * 1024) {
        fail('managed release exceeds inventory limits');
      }
    }
  }
  records.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return records;
}

async function verifyReleaseInventory(releaseRoot, options = {}) {
  const inventoryPath = path.join(releaseRoot, RELEASE_INVENTORY_NAME);
  if (!(await pathExists(inventoryPath))) {
    if (options.required) fail(`managed release inventory is missing: ${releaseRoot}`);
    return;
  }
  const inventory = await readPrivateJson(inventoryPath, {
    expectedUid: options.expectedUid,
    platform: options.platform,
    maxBytes: 16 * 1024 * 1024,
  });
  if (
    inventory.schemaVersion !== SCHEMA_VERSION ||
    inventory.owner !== OWNER ||
    !isKnownRepository(inventory.repository) ||
    !Array.isArray(inventory.records)
  ) {
    fail(`managed release inventory is invalid: ${releaseRoot}`);
  }
  const actual = await buildReleaseInventory(releaseRoot, options.platform);
  if (JSON.stringify(inventory.records) !== JSON.stringify(actual)) {
    fail(`managed release integrity check failed: ${releaseRoot}`);
  }
}

async function validateLaunchers(manifest, installRoot, { expectedUid, platform }) {
  const pathApi = pathApiFor(platform);
  const expectedDirectory = pathApi.join(installRoot, 'bin');
  const receipt = manifest.launcher;
  assertAbsolutePath(receipt.directory, 'launcher directory', platform);
  if (!samePath(receipt.directory, expectedDirectory, platform)) {
    fail('launcher directory is outside the managed install root');
  }
  if (!Array.isArray(receipt.files) || receipt.files.length === 0) {
    fail('launcher file receipts are missing');
  }
  await assertDirectory(expectedDirectory, {
    expectedUid,
    platform,
    privateDirectory: true,
  });
  const expectedNames = new Set(platform === 'win32'
    ? ['agygram.mjs', 'agygram.cmd']
    : ['agygram.mjs', 'agygram']);
  const seen = new Set();
  const files = [];
  for (const item of receipt.files) {
    if (item == null || typeof item !== 'object' || item.kind !== 'file') {
      fail('launcher receipt contains an unsupported entry');
    }
    assertAbsolutePath(item.path, 'launcher path', platform);
    if (!isWithin(expectedDirectory, item.path, platform)) fail('launcher path escapes its directory');
    const name = pathApi.basename(item.path);
    if (!expectedNames.has(name) || !samePath(item.path, pathApi.join(expectedDirectory, name), platform)) {
      fail(`unexpected launcher path: ${item.path}`);
    }
    if (seen.has(name)) fail(`duplicate launcher receipt: ${name}`);
    seen.add(name);
    if (typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
      fail(`invalid launcher hash: ${name}`);
    }
    await assertRegularFile(item.path, { expectedUid, platform });
    const actualHash = await sha256File(item.path);
    if (actualHash !== item.sha256) fail(`launcher was modified after installation: ${item.path}`);
    files.push({ path: item.path, sha256: item.sha256 });
  }
  if (seen.size !== expectedNames.size || [...expectedNames].some((name) => !seen.has(name))) {
    fail('launcher receipt does not describe the complete managed launcher set');
  }
  const diskEntries = await readdir(expectedDirectory);
  if (
    diskEntries.length !== expectedNames.size ||
    diskEntries.some((name) => !expectedNames.has(name))
  ) {
    fail('launcher directory contains unmanaged entries');
  }
  return files;
}

async function validateInstallation(installRoot, defaults, {
  expectedUid,
  platform,
  allowPartial = false,
} = {}) {
  await assertDirectory(installRoot, {
    privateDirectory: true,
    expectedUid,
    platform,
  });
  const rootMarkerPath = path.join(installRoot, ROOT_MARKER_NAME);
  const rootMarker = await readPrivateJson(rootMarkerPath, { expectedUid, platform });
  validateRootMarker(rootMarker, installRoot, platform);

  const manifestPath = path.join(installRoot, MANIFEST_NAME);
  const manifest = validateManifest(
    await readPrivateJson(manifestPath, { expectedUid, platform }),
    { installRoot, defaults, platform },
  );
  const uninstallReceiptPath = path.join(installRoot, UNINSTALL_RECEIPT_NAME);
  const uninstallReceipt = await pathExists(uninstallReceiptPath)
    ? validateUninstallReceipt(
      await readPrivateJson(uninstallReceiptPath, { expectedUid, platform }),
      manifest,
    )
    : null;
  const partialAllowed = Boolean(uninstallReceipt) || (allowPartial && !manifest.serviceInstalled);
  const currentPath = path.join(installRoot, CURRENT_NAME);
  const currentPresent = await pathExists(currentPath);
  if (currentPresent) {
    await assertRegularFile(currentPath, { privateFile: true, expectedUid, platform });
    const pointer = await readSmallFile(currentPath, 512);
    if (!pointer.equals(Buffer.from(`${manifest.currentRelease}\n`, 'utf8'))) {
      fail('current release pointer does not match the manifest');
    }
  } else if (!partialAllowed) {
    fail('current release pointer is missing');
  }

  const releasesRoot = path.join(installRoot, 'releases');
  const releaseNames = [];
  if (await pathExists(releasesRoot)) {
    await assertDirectory(releasesRoot, {
      privateDirectory: true,
      expectedUid,
      platform,
    });
    for (const entry of await readdir(releasesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        fail(`releases directory contains an unmanaged entry: ${entry.name}`);
      }
      validateReleaseName(entry.name);
      const releaseRoot = path.join(releasesRoot, entry.name);
      await validateReleaseDirectory(releaseRoot, entry.name, {
        manifest,
        expectedUid,
        platform,
        current: entry.name === manifest.currentRelease,
      });
      releaseNames.push(entry.name);
    }
  } else if (!partialAllowed) {
    fail('managed releases directory is missing');
  }

  if (!releaseNames.includes(manifest.currentRelease) && !partialAllowed) {
    fail('manifest current release is missing');
  }
  if (
    manifest.previousRelease != null &&
    !releaseNames.includes(manifest.previousRelease) &&
    !partialAllowed
  ) {
    fail('manifest previous release is missing');
  }
  const referenced = new Set([
    manifest.currentRelease,
    ...(manifest.previousRelease == null ? [] : [manifest.previousRelease]),
  ]);
  if (releaseNames.some((name) => !referenced.has(name))) {
    fail('releases directory contains a release not owned by the manifest');
  }

  let launcherFiles = [];
  const launcherDirectory = path.join(installRoot, 'bin');
  if (await pathExists(launcherDirectory)) {
    launcherFiles = await validateLaunchers(manifest, installRoot, { expectedUid, platform });
  } else if (!partialAllowed) {
    fail('managed launcher directory is missing');
  }

  const allowedRootEntries = new Set([
    ROOT_MARKER_NAME,
    MANIFEST_NAME,
    CURRENT_NAME,
    LOCK_NAME,
    UNINSTALL_RECEIPT_NAME,
    'bin',
    'releases',
  ]);
  const rootEntries = await readdir(installRoot);
  const unmanaged = rootEntries.filter((name) => !allowedRootEntries.has(name));
  if (unmanaged.length > 0) fail(`install root contains unmanaged entries: ${unmanaged.join(', ')}`);

  return {
    manifestPath,
    currentPath,
    releasesRoot,
    releaseNames,
    launcherDirectory,
    launcherFiles,
    manifest,
    uninstallReceipt,
    uninstallReceiptPath,
    currentPresent,
  };
}

function transactionReleaseNames(transaction) {
  const names = new Set();
  for (const manifest of [transaction.previousManifest, transaction.targetManifest]) {
    if (!manifest) continue;
    names.add(manifest.currentRelease);
    if (manifest.previousRelease != null) names.add(manifest.previousRelease);
  }
  return names;
}

function transactionServicesCleared(transaction) {
  return transaction.phase === 'old-service-stopped' &&
    transaction.previousServiceActive === false &&
    transaction.previousManifest?.serviceInstalled !== true &&
    transaction.targetManifest.serviceInstalled === false;
}

async function readCurrentPointer(currentPath, expectedUid, platform) {
  if (!(await pathExists(currentPath))) return null;
  await assertRegularFile(currentPath, { privateFile: true, expectedUid, platform });
  const value = await readSmallFile(currentPath, 512);
  const text = value.toString('utf8');
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
    fail('current release pointer has invalid encoding');
  }
  const releaseName = text.slice(0, -1);
  validateReleaseName(releaseName, 'current release pointer');
  return releaseName;
}

async function validateTransactionInstallation(installRoot, defaults, {
  expectedUid,
  platform,
} = {}) {
  await assertDirectory(installRoot, {
    privateDirectory: true,
    expectedUid,
    platform,
  });
  const rootMarkerPath = path.join(installRoot, ROOT_MARKER_NAME);
  const rootMarker = await readPrivateJson(rootMarkerPath, { expectedUid, platform });
  validateRootMarker(rootMarker, installRoot, platform);
  const transactionPath = path.join(installRoot, TRANSACTION_NAME);
  const transaction = validateTransaction(
    await readPrivateJson(transactionPath, {
      expectedUid,
      platform,
      maxBytes: 2 * 1024 * 1024,
    }),
    { installRoot, defaults, platform },
  );
  const cleared = transactionServicesCleared(transaction);
  const expectedDiskManifests = transaction.phase === 'new-service-started'
    ? [transaction.targetManifest, transaction.previousManifest].filter(Boolean)
    : ['prepared', 'old-service-stopped'].includes(transaction.phase)
      ? [transaction.previousManifest].filter(Boolean)
      : [transaction.targetManifest];
  const manifestPath = path.join(installRoot, MANIFEST_NAME);
  const currentPath = path.join(installRoot, CURRENT_NAME);
  let diskManifest = null;
  if (await pathExists(manifestPath)) {
    diskManifest = validateManifest(
      await readPrivateJson(manifestPath, { expectedUid, platform }),
      { installRoot, defaults, platform },
    );
    const accepted = cleared
      ? [transaction.previousManifest, transaction.targetManifest].filter(Boolean)
      : expectedDiskManifests;
    if (!accepted.some((candidate) => sameManifest(diskManifest, candidate))) {
      fail('transaction and installed manifest do not agree');
    }
  } else if (!cleared && expectedDiskManifests.length > 0) {
    fail('transaction references a missing installed manifest');
  }

  const pointer = await readCurrentPointer(currentPath, expectedUid, platform);
  const acceptedPointers = cleared
    ? new Set([
      transaction.previousManifest?.currentRelease,
      transaction.targetManifest.currentRelease,
      null,
    ])
    : new Set(expectedDiskManifests.length === 0
      ? [null]
      : expectedDiskManifests.map((manifest) => manifest.currentRelease));
  if (!acceptedPointers.has(pointer)) fail('transaction and current pointer do not agree');

  const ownedNames = transactionReleaseNames(transaction);
  const releasesRoot = path.join(installRoot, 'releases');
  const releaseNames = [];
  if (await pathExists(releasesRoot)) {
    await assertDirectory(releasesRoot, {
      privateDirectory: true,
      expectedUid,
      platform,
    });
    for (const entry of await readdir(releasesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !ownedNames.has(entry.name)) {
        fail(`transaction releases directory contains an unmanaged entry: ${entry.name}`);
      }
      const identityManifest = [transaction.targetManifest, transaction.previousManifest]
        .find((manifest) => manifest?.currentRelease === entry.name);
      await validateReleaseDirectory(path.join(releasesRoot, entry.name), entry.name, {
        manifest: identityManifest ?? transaction.targetManifest,
        expectedUid,
        platform,
        current: Boolean(identityManifest),
      });
      releaseNames.push(entry.name);
    }
  } else if (!cleared) {
    fail('transaction managed releases directory is missing');
  }
  if (!cleared && [...ownedNames].some((name) => !releaseNames.includes(name))) {
    fail('transaction references a missing managed release');
  }

  const launcherDirectory = path.join(installRoot, 'bin');
  let launcherFiles = [];
  if (await pathExists(launcherDirectory)) {
    launcherFiles = await validateLaunchers(transaction.targetManifest, installRoot, {
      expectedUid,
      platform,
    });
  } else if (!cleared) {
    fail('transaction managed launcher directory is missing');
  }

  const allowedRootEntries = new Set([
    ROOT_MARKER_NAME,
    MANIFEST_NAME,
    CURRENT_NAME,
    LOCK_NAME,
    TRANSACTION_NAME,
    'bin',
    'releases',
  ]);
  const unmanaged = (await readdir(installRoot)).filter((name) => !allowedRootEntries.has(name));
  if (unmanaged.length > 0) fail(`install root contains unmanaged entries: ${unmanaged.join(', ')}`);

  return {
    transactionPath,
    manifestPath,
    currentPath,
    releasesRoot,
    releaseNames,
    launcherDirectory,
    launcherFiles,
    transaction,
    diskManifest,
    cleared,
  };
}

function lockBody(pid, hostname, now) {
  return {
    schemaVersion: SCHEMA_VERSION,
    owner: OWNER,
    pid,
    hostname,
    token: randomUUID(),
    createdAt: now.toISOString(),
  };
}

function validateLock(value) {
  if (value.schemaVersion !== SCHEMA_VERSION || value.owner !== OWNER) {
    fail('installer lock is not managed by agygram');
  }
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) fail('installer lock PID is invalid');
  if (typeof value.hostname !== 'string' || value.hostname.length === 0) {
    fail('installer lock hostname is invalid');
  }
  if (typeof value.token !== 'string' || value.token.length < 16 || value.token.length > 128) {
    fail('installer lock token is invalid');
  }
  assertTimestamp(value.createdAt, 'installer lock createdAt');
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function acquireInstallerLock(installRoot, {
  expectedUid,
  platform,
  pid = process.pid,
  hostname = os.hostname(),
  now = () => new Date(),
  processAlive = defaultProcessAlive,
} = {}) {
  const lockPath = path.join(installRoot, LOCK_NAME);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const value = lockBody(pid, hostname, now());
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (platform !== 'win32') await chmod(lockPath, 0o600);
      let released = false;
      return {
        path: lockPath,
        value,
        async release() {
          if (released) return;
          if (!(await pathExists(lockPath))) {
            released = true;
            return;
          }
          const current = await readPrivateJson(lockPath, { expectedUid, platform });
          if (JSON.stringify(current) !== JSON.stringify(value)) {
            fail('installer lock ownership changed while uninstalling');
          }
          await unlink(lockPath);
          released = true;
        },
        abandonAfterRootRemoval() {
          released = true;
        },
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code !== 'EEXIST') throw error;
    }

    let existingInfo;
    try {
      existingInfo = await assertRegularFile(lockPath, {
        privateFile: true,
        expectedUid,
        platform,
      });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const raw = await readSmallFile(lockPath);
    let existing;
    try {
      existing = JSON.parse(raw.toString('utf8'));
    } catch {
      fail('installer lock contains invalid JSON');
    }
    validateLock(existing);
    if (existing.hostname !== hostname) {
      fail(`installation is locked by PID ${existing.pid} on host ${existing.hostname}`);
    }
    if (processAlive(existing.pid)) {
      fail(`installation is locked by live PID ${existing.pid}`);
    }

    const beforeRemove = await lstat(lockPath);
    const unchanged =
      beforeRemove.size === existingInfo.size &&
      beforeRemove.mtimeMs === existingInfo.mtimeMs &&
      (platform === 'win32' || beforeRemove.ino === existingInfo.ino);
    if (!unchanged) fail('installer lock changed while checking stale ownership');
    const reread = await readFile(lockPath, 'utf8');
    if (reread !== raw.toString('utf8')) fail('installer lock changed while checking stale ownership');
    try {
      await unlink(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  fail('unable to acquire the installer lock');
}

function sanitizedChildEnvironment(source, platform, serviceEnvironment = {}) {
  const env = {};
  const blocked = /^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.+|BASH_ENV|ENV)$/iu;
  for (const [key, value] of Object.entries(source)) {
    if (value != null && !blocked.test(key)) env[key] = String(value);
  }
  if (platform === 'linux') {
    if (Object.hasOwn(serviceEnvironment, 'xdgConfigHome')) {
      if (serviceEnvironment.xdgConfigHome == null) delete env.XDG_CONFIG_HOME;
      else env.XDG_CONFIG_HOME = serviceEnvironment.xdgConfigHome;
    }
  }
  if (platform === 'darwin') {
    env.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  } else if (platform === 'linux') {
    env.PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  }
  return env;
}

async function runServiceUninstall({
  releaseRoot,
  configFile,
  dataDir,
  env,
  platform,
  serviceEnvironment,
}) {
  const entry = path.join(releaseRoot, 'bin', 'agygram.js');
  const args = [
    '--',
    entry,
    'service',
    'uninstall',
    '--project-dir',
    releaseRoot,
    '--config-file',
    configFile,
    '--data-dir',
    dataDir,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: releaseRoot,
      env: sanitizedChildEnvironment(env, platform, serviceEnvironment),
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    let settled = false;
    let timedOut = false;
    let forceTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, SERVICE_TIMEOUT_MS);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      if (timedOut) reject(new Error(`native service removal timed out after ${SERVICE_TIMEOUT_MS}ms`));
      else if (code === 0) resolve();
      else if (signal) reject(new Error(`native service removal stopped by signal ${signal}`));
      else reject(new Error(`native service removal failed with exit code ${code}`));
    });
  });
}

async function atomicWritePrivateJson(target, value, platform) {
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    if (platform !== 'win32') await chmod(target, 0o600);
    try {
      const directory = await open(path.dirname(target), fsConstants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function transactionServiceCandidates(transaction) {
  if (transactionServicesCleared(transaction)) return [];
  if (transaction.phase === 'prepared') {
    return transaction.previousServiceActive
      ? [transaction.previousManifest]
      : [];
  }
  if (
    transaction.phase === 'old-service-stopped' &&
    transaction.previousManifest?.currentRelease === transaction.targetManifest.currentRelease &&
    transaction.targetManifest.serviceInstalled
  ) {
    // Same-release service repinning installs immediately after this phase;
    // the install can succeed before new-service-started is persisted.
    return [transaction.targetManifest];
  }
  if (transaction.phase === 'state-written' || transaction.phase === 'new-service-started') {
    // The service install may have completed immediately before the phase write.
    return [transaction.targetManifest];
  }
  return [];
}

async function markTransactionServicesCleared(installation, platform) {
  const clear = (manifest) => manifest == null ? null : {
    ...manifest,
    serviceInstalled: false,
    updatedAt: new Date().toISOString(),
  };
  const updated = {
    ...installation.transaction,
    phase: 'old-service-stopped',
    previousServiceActive: false,
    previousManifest: clear(installation.transaction.previousManifest),
    targetManifest: clear(installation.transaction.targetManifest),
    updatedAt: new Date().toISOString(),
  };
  await atomicWritePrivateJson(installation.transactionPath, updated, platform);
  if (installation.diskManifest != null && await pathExists(installation.manifestPath)) {
    const matchedPrevious = installation.transaction.previousManifest != null &&
      sameManifest(installation.diskManifest, installation.transaction.previousManifest);
    const matchedTarget = sameManifest(
      installation.diskManifest,
      installation.transaction.targetManifest,
    );
    const matching = matchedPrevious
      ? updated.previousManifest
      : matchedTarget
        ? updated.targetManifest
        : null;
    if (matching == null) fail('installed manifest changed while clearing transaction services');
    await atomicWritePrivateJson(installation.manifestPath, matching, platform);
  }
  return updated;
}

function detachedRootPath(installRoot) {
  return path.join(
    path.dirname(installRoot),
    `.${path.basename(installRoot)}.agygram-uninstalling`,
  );
}

async function finalizeTinyRoot(installRoot, lock) {
  const expected = new Set([ROOT_MARKER_NAME, LOCK_NAME]);
  const entries = await readdir(installRoot);
  if (entries.some((name) => !expected.has(name))) {
    fail('managed root changed during final cleanup');
  }
  const quarantine = detachedRootPath(installRoot);
  if (await pathExists(quarantine)) fail(`stale detached uninstall root requires recovery: ${quarantine}`);
  await rename(installRoot, quarantine);
  lock.abandonAfterRootRemoval();
  await unlink(path.join(quarantine, LOCK_NAME));
  await unlink(path.join(quarantine, ROOT_MARKER_NAME));
  await rmdir(quarantine);
}

async function cleanupDetachedRoot(installRoot, {
  expectedUid,
  platform,
  hostname = os.hostname(),
  processAlive = defaultProcessAlive,
} = {}) {
  const detached = detachedRootPath(installRoot);
  if (!(await pathExists(detached))) return false;
  await assertDirectory(detached, {
    privateDirectory: true,
    expectedUid,
    platform,
  });
  const entries = await readdir(detached);
  const allowed = new Set([ROOT_MARKER_NAME, LOCK_NAME]);
  if (entries.some((name) => !allowed.has(name))) {
    fail(`detached uninstall root contains unmanaged entries: ${detached}`);
  }
  const markerPath = path.join(detached, ROOT_MARKER_NAME);
  if (entries.includes(ROOT_MARKER_NAME)) {
    const marker = await readPrivateJson(markerPath, { expectedUid, platform });
    validateRootMarker(marker, installRoot, platform);
  } else if (entries.length > 0) {
    fail(`detached uninstall root lost its ownership marker: ${detached}`);
  }
  if (entries.includes(LOCK_NAME)) {
    const lockPath = path.join(detached, LOCK_NAME);
    const lock = await readPrivateJson(lockPath, { expectedUid, platform });
    validateLock(lock);
    if (lock.hostname !== hostname || processAlive(lock.pid)) {
      fail(`detached uninstall root is still owned by PID ${lock.pid} on ${lock.hostname}`);
    }
    await unlink(lockPath);
  }
  if (await pathExists(markerPath)) await unlink(markerPath);
  await rmdir(detached);
  return true;
}

async function cleanupFinalPartialRoot(installRoot, {
  expectedUid,
  platform,
  processAlive,
} = {}) {
  const entries = await readdir(installRoot);
  const allowed = new Set([ROOT_MARKER_NAME, LOCK_NAME, UNINSTALL_RECEIPT_NAME]);
  if (entries.some((name) => !allowed.has(name))) return false;
  if (!entries.includes(ROOT_MARKER_NAME)) return false;
  const marker = await readPrivateJson(path.join(installRoot, ROOT_MARKER_NAME), {
    expectedUid,
    platform,
  });
  validateRootMarker(marker, installRoot, platform);
  const receiptPath = path.join(installRoot, UNINSTALL_RECEIPT_NAME);
  if (entries.includes(UNINSTALL_RECEIPT_NAME)) {
    validateUninstallReceipt(
      await readPrivateJson(receiptPath, { expectedUid, platform }),
    );
  }
  const lock = await acquireInstallerLock(installRoot, {
    expectedUid,
    platform,
    processAlive,
  });
  try {
    if (await pathExists(receiptPath)) await unlink(receiptPath);
    await finalizeTinyRoot(installRoot, lock);
  } finally {
    await lock.release().catch(() => {});
  }
  return true;
}

export async function uninstallManagedInstallation(options = {}, dependencies = {}) {
  assertTestDependencies(dependencies);
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const homeDir = dependencies.homeDir ?? os.homedir();
  const home = validateHome(homeDir, platform);
  const requestedRoot = options.installRoot ?? environmentInstallRoot(env, platform);
  const defaults = requestedRoot == null
    ? platformDefaults({ platform, env, homeDir: home })
    : { homeDir: home };
  const installRoot = assertSafeInstallRoot(
    requestedRoot ?? defaults.installRoot,
    defaults.homeDir,
    platform,
  );
  const output = dependencies.output ?? process.stdout.write.bind(process.stdout);
  const warning = dependencies.warning ?? process.stderr.write.bind(process.stderr);
  const expectedUid = platform === 'win32' ? undefined : (dependencies.uid ?? process.getuid?.());
  const processAlive = dependencies.processAlive ?? defaultProcessAlive;
  const serviceRunner = dependencies.runServiceUninstall ?? runServiceUninstall;

  if (
    platform !== 'win32' &&
    expectedUid === 0 &&
    dependencies.allowRoot !== true
  ) {
    fail('refusing to uninstall as root; run as the user who owns the agy OAuth credentials');
  }

  const detachedRecovered = await cleanupDetachedRoot(installRoot, {
    expectedUid,
    platform,
    processAlive,
  });

  if (!(await pathExists(installRoot))) {
    output(
      detachedRecovered
        ? `agygram is already uninstalled (${installRoot}); completed detached metadata cleanup.\n`
        : `agygram is already uninstalled (${installRoot}).\n`,
    );
    return { removed: false, installRoot, version: null };
  }
  await assertDirectory(installRoot, {
    privateDirectory: true,
    expectedUid,
    platform,
  });

  const manifestPath = path.join(installRoot, MANIFEST_NAME);
  const transactionPath = path.join(installRoot, TRANSACTION_NAME);
  const hasTransaction = await pathExists(transactionPath);
  if (!(await pathExists(manifestPath)) && !hasTransaction) {
    if (await cleanupFinalPartialRoot(installRoot, {
      expectedUid,
      platform,
      processAlive,
    })) {
      output(`agygram is already uninstalled (${installRoot}); completed metadata cleanup.\n`);
      return { removed: false, installRoot, version: null };
    }
    fail('refusing to remove an unmanaged directory: managed manifest is missing');
  }

  if (hasTransaction) {
    let transactionInstallation = await validateTransactionInstallation(installRoot, defaults, {
      expectedUid,
      platform,
    });
    const transactionLock = await acquireInstallerLock(installRoot, {
      expectedUid,
      platform,
      processAlive,
    });
    try {
      transactionInstallation = await validateTransactionInstallation(installRoot, defaults, {
        expectedUid,
        platform,
      });
      for (const candidate of transactionServiceCandidates(transactionInstallation.transaction)) {
        const releaseRoot = path.join(
          transactionInstallation.releasesRoot,
          candidate.currentRelease,
        );
        try {
          await serviceRunner({
            releaseRoot,
            configFile: candidate.configFile,
            dataDir: candidate.dataDir,
            env,
            platform,
            serviceEnvironment: candidate.serviceEnvironment,
          });
        } catch (error) {
          fail(`transaction service state could not be made absent; managed files were preserved: ${error.message}`);
        }
      }
      if (!transactionInstallation.cleared) {
        await markTransactionServicesCleared(transactionInstallation, platform);
        transactionInstallation = await validateTransactionInstallation(installRoot, defaults, {
          expectedUid,
          platform,
        });
      }

      if (await pathExists(transactionInstallation.launcherDirectory)) {
        const files = await validateLaunchers(
          transactionInstallation.transaction.targetManifest,
          installRoot,
          { expectedUid, platform },
        );
        for (const launcher of files) await unlink(launcher.path);
        await rmdir(transactionInstallation.launcherDirectory);
      }
      for (const releaseName of transactionInstallation.releaseNames) {
        const releaseRoot = path.join(transactionInstallation.releasesRoot, releaseName);
        const identityManifest = [
          transactionInstallation.transaction.targetManifest,
          transactionInstallation.transaction.previousManifest,
        ].find((manifest) => manifest?.currentRelease === releaseName);
        await validateReleaseDirectory(releaseRoot, releaseName, {
          manifest: identityManifest ?? transactionInstallation.transaction.targetManifest,
          expectedUid,
          platform,
          current: Boolean(identityManifest),
        });
        await rm(releaseRoot, { recursive: true, force: false });
      }
      if (await pathExists(transactionInstallation.releasesRoot)) {
        await rmdir(transactionInstallation.releasesRoot);
      }
      if (await pathExists(transactionInstallation.currentPath)) {
        await unlink(transactionInstallation.currentPath);
      }
      if (await pathExists(transactionInstallation.manifestPath)) {
        await unlink(transactionInstallation.manifestPath);
      }
      await unlink(transactionInstallation.transactionPath);
      await finalizeTinyRoot(installRoot, transactionLock);
      const version = transactionInstallation.transaction.targetManifest.version;
      output(
        `Removed agygram ${version} and recovered an interrupted managed update. ` +
        'Configuration, data, workspace, credentials, and Linux linger were preserved.\n',
      );
      return {
        removed: true,
        recoveredTransaction: true,
        installRoot,
        version,
      };
    } finally {
      await transactionLock.release().catch((error) => {
        warning(`warning: could not release installer lock: ${error.message}\n`);
      });
    }
  }

  // Validate before locking so a malformed receipt cannot cause unrelated mutation.
  let installation = await validateInstallation(installRoot, defaults, {
    expectedUid,
    platform,
  });
  const lock = await acquireInstallerLock(installRoot, {
    expectedUid,
    platform,
    processAlive,
  });
  try {
    // Re-read every ownership receipt after acquiring the cooperative installer lock.
    installation = await validateInstallation(installRoot, defaults, {
      expectedUid,
      platform,
    });
    const { manifest } = installation;
    const version = manifest.version;

    const currentReleaseAvailable = installation.releaseNames.includes(manifest.currentRelease);
    if (!installation.uninstallReceipt && currentReleaseAvailable) {
      const releaseRoot = path.join(installation.releasesRoot, manifest.currentRelease);
      try {
        await serviceRunner({
          releaseRoot,
          configFile: manifest.configFile,
          dataDir: manifest.dataDir,
          env,
          platform,
          serviceEnvironment: manifest.serviceEnvironment,
        });
      } catch (error) {
        fail(`native service was not removed; managed files were preserved: ${error.message}`);
      }
      await atomicWritePrivateJson(installation.uninstallReceiptPath, {
        schemaVersion: SCHEMA_VERSION,
        owner: OWNER,
        repository: REPOSITORY,
        version: manifest.version,
        commit: manifest.commit,
        currentRelease: manifest.currentRelease,
        serviceAbsent: true,
        createdAt: new Date().toISOString(),
      }, platform);
      if (manifest.serviceInstalled) {
        const updated = {
          ...manifest,
          serviceInstalled: false,
          updatedAt: new Date().toISOString(),
        };
        await atomicWritePrivateJson(installation.manifestPath, updated, platform);
      }
      installation = await validateInstallation(installRoot, defaults, {
        expectedUid,
        platform,
      });
    }

    // Exact launcher hashes are rechecked immediately before their removal.
    if (await pathExists(installation.launcherDirectory)) {
      const launcherFiles = await validateLaunchers(installation.manifest, installRoot, {
        expectedUid,
        platform,
      });
      for (const launcher of launcherFiles) await unlink(launcher.path);
      await rmdir(installation.launcherDirectory);
    }

    for (const releaseName of installation.releaseNames) {
      const releaseRoot = path.join(installation.releasesRoot, releaseName);
      await validateReleaseDirectory(releaseRoot, releaseName, {
        manifest: installation.manifest,
        expectedUid,
        platform,
        current: releaseName === installation.manifest.currentRelease,
        auditTree: true,
      });
      await rm(releaseRoot, { recursive: true, force: false });
    }
    if (await pathExists(installation.releasesRoot)) {
      await rmdir(installation.releasesRoot);
    }
    if (await pathExists(installation.currentPath)) await unlink(installation.currentPath);
    await unlink(installation.manifestPath);
    if (await pathExists(installation.uninstallReceiptPath)) {
      await unlink(installation.uninstallReceiptPath);
    }
    await finalizeTinyRoot(installRoot, lock);

    output(
      `Removed agygram ${version}. Configuration, data, workspace, credentials, and Linux linger were preserved.\n`,
    );
    return {
      removed: true,
      installRoot,
      version,
      preserved: [manifest.configFile, manifest.dataDir, manifest.workspaceDir],
    };
  } finally {
    await lock.release().catch((error) => {
      warning(`warning: could not release installer lock: ${error.message}\n`);
    });
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  assertTestDependencies(dependencies);
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const homeDir = dependencies.homeDir ?? os.homedir();
  const parsed = parseArguments(argv, {}, platform);
  if (parsed.help) {
    (dependencies.output ?? process.stdout.write.bind(process.stdout))(USAGE);
    return 0;
  }
  if (parsed.installRoot == null) {
    parsed.installRoot = environmentInstallRoot(env, platform) ??
      platformDefaults({ platform, env, homeDir }).installRoot;
  }
  await uninstallManagedInstallation({ installRoot: parsed.installRoot }, dependencies);
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`agygram uninstall: ${error.message}\n`);
      process.exitCode = 1;
    });
}

export const _private = {
  CURRENT_NAME,
  LOCK_NAME,
  MANIFEST_NAME,
  OWNER,
  RELEASE_MARKER_NAME,
  REPOSITORY,
  ROOT_MARKER_NAME,
  acquireInstallerLock,
  assertSafeInstallRoot,
  isWithin,
  parseArguments,
  pathApiFor,
  platformDefaults,
  runServiceUninstall,
  samePath,
  sanitizedChildEnvironment,
  validateInstallation,
  validateManifest,
};
