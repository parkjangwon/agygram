import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Best-effort directory fsync after an atomic rename.
 * Unsupported on Windows and some filesystems; the file itself is still fsynced.
 */
export async function syncDirectoryBestEffort(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some platforms/filesystems.
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Write `contents` to `file` via temp + fsync + rename.
 * @param {string} file
 * @param {string|Buffer} contents
 * @param {{ extension?: string, mode?: number }} [options]
 */
export async function atomicWriteFile(file, contents, {
  extension = '.tmp',
  mode = 0o600,
} = {}) {
  if (typeof extension !== 'string' || !extension.startsWith('.')) {
    throw new TypeError('atomicWriteFile extension must start with "."');
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}${extension}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(contents, typeof contents === 'string' ? 'utf8' : undefined);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    await syncDirectoryBestEffort(path.dirname(file));
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * JSON-serialize `data` (pretty-printed + trailing newline) and write atomically.
 */
export async function atomicWriteJson(file, data) {
  return atomicWriteFile(file, `${JSON.stringify(data, null, 2)}\n`);
}
