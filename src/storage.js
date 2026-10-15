import { mkdir, chmod, open, readFile, stat, readdir, rename, rm, link } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function openState(directory, key) {
  await privateDirectory(directory);
  const lockPath = join(directory, '.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new Error('State directory is locked; see README for crash recovery.'); }
  try { await lock.writeFile(String(process.pid)); }
  catch (error) { await lock.close(); await rm(lockPath, { force: true }); throw error; }
  const path = join(directory, `${key}.json`);
  const temporary = join(directory, '.state.tmp');
  return {
    path,
    async read() {
      try {
        if ((await stat(path)).size > 32_768) throw new Error('State too large.');
        const value = JSON.parse(await readFile(path, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('State must be an object.');
        return value;
      } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Invalid state file. Restore a valid backup before continuing.'); }
    },
    async write(value) {
      try { await stat(path); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if ((await readdir(directory)).filter((name) => name.endsWith('.json')).length >= 100) throw new Error('State limit reached (100 jobs). Archive completed jobs before adding one.');
      }
      const file = await open(temporary, 'w', 0o600);
      try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
    },
    async close() { await lock.close(); await rm(temporary, { force: true }); await rm(lockPath, { force: true }); },
  };
}

/** Publish complete bytes atomically, refusing to replace a different file. */
export async function publishOutput(directory, filename, value) {
  await privateDirectory(directory);
  const path = join(directory, filename);
  const temporary = join(directory, `.output-${randomUUID()}.tmp`);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes); await file.sync(); await file.close();
    try { await link(temporary, path); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if ((await stat(path)).size > 32_768 || await readFile(path, 'utf8') !== bytes) {
        throw new Error('Output already exists with different contents; it was not overwritten.');
      }
    }
    return path;
  } finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
}
