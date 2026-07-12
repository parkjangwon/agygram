import path from 'node:path';

function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function assertCleanPath(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty path`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} cannot contain control characters`);
  }
}

function isFullyAbsolute(value, platform) {
  return platform === 'win32'
    ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u.test(value)
    : path.posix.isAbsolute(value);
}

function assertAbsoluteRuntimePath(value, name, platform) {
  assertCleanPath(value, name);
  if (!isFullyAbsolute(value, platform)) {
    throw new Error(`${name} must be absolute`);
  }
}

export function parseFileRunnerArguments(argv, platform = process.platform) {
  if (!Array.isArray(argv)) throw new TypeError('file-runner argv must be an array');
  const options = {};
  const names = new Map([
    ['--data-dir', ['dataDir', 'runtime data directory']],
    ['--config-file', ['envFile', 'runtime configuration file']],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const definition = names.get(option);
    if (!definition) {
      throw new Error(`Unknown runtime option: ${option}`);
    }
    if (seen.has(option)) throw new Error(`Duplicate runtime option: ${option}`);
    seen.add(option);
    const value = argv[index + 1];
    if (value == null || names.has(value) || value.startsWith('--')) {
      throw new Error(`Missing value after ${option}`);
    }
    index += 1;
    const [property, label] = definition;
    assertAbsoluteRuntimePath(value, label, platform);
    options[property] = value;
  }
  return options;
}

export function resolveRuntimeEnvFile({
  projectDir,
  configuredEnvFile,
  platform = process.platform,
}) {
  const pathApi = pathFor(platform);
  assertAbsoluteRuntimePath(projectDir, 'project directory', platform);
  const selected = configuredEnvFile ?? pathApi.join(projectDir, '.env');
  assertAbsoluteRuntimePath(selected, 'runtime environment file', platform);
  return pathApi.resolve(selected);
}

export function resolveServiceDataDir({
  projectDir,
  configuredDataDir,
  env = process.env,
  platform = process.platform,
}) {
  const pathApi = pathFor(platform);
  assertCleanPath(projectDir, 'project directory');
  if (!pathApi.isAbsolute(projectDir)) throw new Error('project directory must be absolute');

  let selected = configuredDataDir ?? env.DATA_DIR;
  if (selected == null || selected === '') {
    selected = platform === 'win32' && env.LOCALAPPDATA
      ? pathApi.join(env.LOCALAPPDATA, 'agygram', 'data')
      : 'data';
  }
  assertCleanPath(selected, 'service data directory');
  return pathApi.resolve(projectDir, selected);
}

export function buildServiceRuntimePaths(dataDir, platform = process.platform) {
  const pathApi = pathFor(platform);
  assertCleanPath(dataDir, 'service data directory');
  if (!pathApi.isAbsolute(dataDir)) throw new Error('service data directory must be absolute');
  const serviceDir = pathApi.join(dataDir, 'runtime', 'service');
  return {
    dataDir,
    serviceDir,
    environmentPath: pathApi.join(serviceDir, 'environment.json'),
    controlScriptPath: pathApi.join(serviceDir, 'task-control.ps1'),
    definitionPath: pathApi.join(serviceDir, 'agygram.xml'),
    stopRequestPath: pathApi.join(serviceDir, 'stop.request.json'),
    logPath: pathApi.join(dataDir, 'logs', 'service.log'),
  };
}

export const _private = { pathFor, assertCleanPath };
