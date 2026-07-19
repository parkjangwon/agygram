import { access, constants as fsConstants, mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  assertManagedStorageBoundary,
  assertRuntimeFilesystemTrust,
} from './runtime-trust.js';

/**
 * Paths that agygram owns under DATA_DIR (stores, uploads, logs, run metadata).
 */
export function listManagedDataPaths(config) {
  const managedDataFiles = [config.stateFile, config.jobFile, config.usageFile];
  const managedDataDirectories = [...new Set([
    config.dataDir,
    ...managedDataFiles.map((file) => path.dirname(file)),
    config.uploadsDir,
    config.resultsDir,
    config.agyRunLogDir,
    path.join(config.dataDir, 'logs'),
    path.join(config.dataDir, 'runtime', 'service'),
  ])];
  return { managedDataFiles, managedDataDirectories };
}

/**
 * Create managed directories, enforce storage boundary, and re-check after mkdir.
 *
 * @param {object} config loaded bot config
 * @param {{
 *   createWorkspace?: boolean,
 *   assertDataDirWritable?: boolean,
 * }} [options]
 */
export async function ensureManagedDataLayout(config, {
  createWorkspace = false,
  assertDataDirWritable = false,
} = {}) {
  const { managedDataFiles, managedDataDirectories } = listManagedDataPaths(config);

  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  // Validate existing ancestors before recursive mkdir can follow an internal
  // symlink/junction and create managed storage outside DATA_DIR.
  await assertManagedStorageBoundary({
    dataDir: config.dataDir,
    files: managedDataFiles,
    directories: managedDataDirectories,
  });

  const creations = managedDataDirectories
    .filter((directory) => directory !== config.dataDir)
    .map((directory) => mkdir(directory, { recursive: true, mode: 0o700 }));
  if (createWorkspace) {
    creations.push(mkdir(config.workspaceDir, { recursive: true, mode: 0o700 }));
  }
  await Promise.all(creations);

  if (assertDataDirWritable) {
    await access(config.dataDir, fsConstants.R_OK | fsConstants.W_OK);
  }

  await assertManagedStorageBoundary({
    dataDir: config.dataDir,
    files: managedDataFiles,
    directories: managedDataDirectories,
  });

  return { managedDataFiles, managedDataDirectories };
}

/**
 * Re-run runtime filesystem trust after managed layout exists.
 */
export async function assertManagedRuntimeTrust({
  config,
  envFile,
  managedDataFiles,
  managedDataDirectories,
}) {
  await assertRuntimeFilesystemTrust({
    envFile,
    dataDirectories: managedDataDirectories,
    dataFiles: managedDataFiles,
    windowsAclVerified: config.windowsAclVerified,
  });
}
