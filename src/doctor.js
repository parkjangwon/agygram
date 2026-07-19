import { lstat } from 'node:fs/promises';
import dotenv from 'dotenv';

import { AgyClient } from './agy.js';
import { loadConfig } from './config.js';
import { buildAgyEnvironment } from './environment.js';
import {
  assertManagedRuntimeTrust,
  ensureManagedDataLayout,
} from './managed-runtime.js';
import { resolveProcessExecutable } from './process-platform.js';
import { assertRuntimeFilesystemTrust } from './runtime-trust.js';
import {
  parseFileRunnerArguments,
  resolveRuntimeEnvFile,
} from './service/runtime-paths.js';
import { prepareWorkspaces, resolveWorkspace } from './workspace.js';
import { AGYGRAM_VERSION } from './version.js';

async function doctor() {
  const runtimeArguments = parseFileRunnerArguments(process.argv.slice(2));
  const pinnedServicePath = runtimeArguments.dataDir ? process.env.PATH : undefined;
  const runtimeEnvFile = resolveRuntimeEnvFile({
    projectDir: process.cwd(),
    configuredEnvFile: runtimeArguments.envFile,
  });
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  let envTrustError = null;
  if (process.platform !== 'win32') {
    try {
      await assertRuntimeFilesystemTrust({ envFile: runtimeEnvFile, dataDirectories: [] });
    } catch (error) {
      envTrustError = error;
    }
  }
  // Do not evaluate a POSIX .env after its path failed the trust preflight.
  if (!envTrustError || process.platform === 'win32') {
    const environmentResult = dotenv.config({
      path: runtimeEnvFile,
      override: runtimeArguments.envFile != null,
      quiet: true,
    });
    if (runtimeArguments.envFile && environmentResult.error) throw environmentResult.error;
  }
  if (runtimeArguments.dataDir) process.env.DATA_DIR = runtimeArguments.dataDir;
  if (pinnedServicePath != null) process.env.PATH = pinnedServicePath;
  let config;
  try {
    config = loadConfig();
    add('환경 설정', true, `${config.allowedChatIds.size}개 채팅 허용`);
  } catch (error) {
    add('환경 설정', false, error.message);
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('agygram', true, `v${AGYGRAM_VERSION}`);
  add('Node.js', [22, 24].includes(nodeMajor), `${process.version} · ${process.platform}/${process.arch}`);

  if (process.platform !== 'win32') {
    if (envTrustError) {
      add('환경 파일 권한', false, envTrustError.message);
    } else try {
      const info = await lstat(runtimeEnvFile);
      const privateMode = (info.mode & 0o077) === 0;
      add(
        '환경 파일 권한',
        info.isFile() && !info.isSymbolicLink() && privateMode,
        info.isSymbolicLink()
          ? '심볼릭 링크는 허용하지 않습니다'
          : privateMode
            ? `${runtimeEnvFile} · 0${(info.mode & 0o777).toString(8)}`
            : `현재 0${(info.mode & 0o777).toString(8)} · chmod 600 ${runtimeEnvFile} 필요`,
      );
    } catch (error) {
      add(
        '환경 파일 권한',
        error.code === 'ENOENT',
        error.code === 'ENOENT'
          ? `${runtimeEnvFile} 없이 프로세스 환경 사용`
          : error.message,
      );
    }
  } else if (config) {
    add(
      'Windows ACL 확인',
      config.windowsAclVerified,
      config.windowsAclVerified
        ? `WINDOWS_ACL_VERIFIED=true (운영자가 ${runtimeEnvFile}와 DATA_DIR DACL을 확인함)`
        : `icacls로 ${runtimeEnvFile}와 DATA_DIR을 현재 사용자 전용으로 제한한 뒤 WINDOWS_ACL_VERIFIED=true를 설정하세요`,
    );
  }
  if (!config) return print(checks);

  let managedDataFiles;
  let managedDataDirectories;
  try {
    ({ managedDataFiles, managedDataDirectories } = await ensureManagedDataLayout(config, {
      createWorkspace: true,
      assertDataDirWritable: true,
    }));
    await assertManagedRuntimeTrust({
      config,
      envFile: runtimeEnvFile,
      managedDataFiles,
      managedDataDirectories,
    });
    const info = await lstat(config.dataDir);
    const privateMode = process.platform === 'win32'
      ? config.windowsAclVerified
      : (info.mode & 0o077) === 0;
    add(
      '데이터 디렉터리',
      info.isDirectory() && !info.isSymbolicLink() && privateMode,
      `${config.dataDir}${privateMode ? '' : process.platform === 'win32' ? ' · DACL 확인 필요' : ' · chmod 700 필요'}`,
    );
  } catch (error) {
    add('데이터 디렉터리', false, error.message);
  }

  let workspace = config.workspaceDir;
  try {
    const roots = await prepareWorkspaces(config.workspaceDir, config.allowedWorkspaceRoots);
    workspace = await resolveWorkspace(config.workspaceDir, {
      defaultWorkspace: config.workspaceDir,
      allowedRoots: roots,
    });
    add('작업공간 경계', true, `${workspace} · 허용 루트 ${roots.length}개`);
  } catch (error) {
    add('작업공간 경계', false, error.message);
  }

  const agyEnvironment = buildAgyEnvironment(process.env, config.agyEnvironmentAllowlist);
  let agyExecutable = config.agyBin;
  try {
    agyExecutable = (await resolveProcessExecutable(config.agyBin, {
      env: agyEnvironment,
      cwd: workspace,
    })).path;
  } catch (error) {
    add('agy 실행 파일', false, error.message);
    return print(checks);
  }
  const agy = new AgyClient({
    bin: agyExecutable,
    authCheckTimeoutMs: config.authCheckTimeoutMs,
    maxOutputBytes: config.agyMaxOutputBytes,
    environment: agyEnvironment,
  });
  try {
    const version = await agy.version({ cwd: workspace });
    add('agy 실행 파일', true, `${version} · ${agyExecutable}`);
  } catch (error) {
    add('agy 실행 파일', false, error.message);
  }

  const catalog = await agy.catalogStatus({ cwd: workspace });
  add(
    'agy 모델 조회',
    catalog.available,
    catalog.available
      ? `모델 ${catalog.models.length}개 · 인증 자체는 실제 요청 또는 /auth로 확인`
      : catalog.detail || catalog.reason || '확인 실패',
  );

  if (process.platform === 'linux') {
    add(
      'Linux D-Bus',
      Boolean(process.env.DBUS_SESSION_BUS_ADDRESS),
      process.env.DBUS_SESSION_BUS_ADDRESS
        ? 'DBUS_SESSION_BUS_ADDRESS 설정됨'
        : '미설정: 재시작 후 OAuth가 사라지면 Secret Service/D-Bus를 구성하세요',
    );
  }
  print(checks);
}

function print(checks) {
  for (const check of checks) {
    console.log(`${check.ok ? 'OK  ' : 'FAIL'} ${check.name}: ${check.detail}`);
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

doctor().catch((error) => {
  console.error(`FAIL doctor: ${error.message}`);
  process.exitCode = 1;
});
