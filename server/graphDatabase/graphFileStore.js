// GraphFileStore: low-level, storage-only file I/O for the file-based
// Graph Database (graphDatabase.js is the public API — this module never
// makes any decision about what a graph *is*, only how bytes get read from
// and written to disk safely). Mirrors this project's own established
// split between a storage-access layer and a business-API layer (see
// server/db/pool.js vs. server/repositories/graphRepository.js) — the same
// separation, just for a filesystem instead of Postgres.
//
// Layout on disk
// ---------------
//   <libraryDir>/graph_<hash>/metadata.json
//   <libraryDir>/graph_<hash>/points.json
//   <libraryDir>/graph_<hash>/notes.md
//
// `libraryDir` defaults to `<repo root>/GraphLibrary`, overridable via the
// GRAPH_LIBRARY_DIR environment variable (e.g. to point it at a synced
// folder). This directory is user-generated data, not source — see
// .gitignore.
//
// Atomic writes
// --------------
// Every write goes to a temporary file in the same directory first, then
// an atomic rename over the real target (fs.rename is atomic on the same
// filesystem/volume, which a temp file in the same directory always is).
// This means a process interrupted mid-write (crash, kill, power loss)
// leaves either the old complete file or the new complete file — never a
// half-written, corrupt one.
//
// Why the directory name isn't the raw hash
// --------------------------------------------
// graphHasher.js's hashGraph output looks like
// `alg1|code(3 1 7 2)|a(15)|b(50)|step(0.1)|len(90)` — perfectly fine as an
// opaque string key in a Map or a Postgres column, but `|` is illegal in a
// Windows path (mkdir fails outright), and a long code sequence could make
// the directory name unreasonably long on any OS. graphDirName instead
// hashes the hash itself (SHA-256, hex-encoded — always a fixed-length,
// filesystem-safe string on every platform) to name the directory; the
// *true* hash is never reconstructed from that name — it's only ever read
// back out of metadata.json's own `hash` field, which is this module's
// entire reason listGraphDirs returns directories, not "recovered" hashes.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const DEFAULT_LIBRARY_DIR = path.join(process.cwd(), 'GraphLibrary');

export const resolveLibraryDir = (baseDir) => baseDir ?? process.env.GRAPH_LIBRARY_DIR ?? DEFAULT_LIBRARY_DIR;

/** A fixed-length, filesystem-safe digest of `hash` — see this module's own comment on why the raw hash can't be used as a path segment directly. */
export const hashToDirSegment = (hash) => createHash('sha256').update(hash).digest('hex');

export const graphDirName = (hash) => `graph_${hashToDirSegment(hash)}`;

export const graphDirPath = (libraryDir, hash) => path.join(libraryDir, graphDirName(hash));

/** Writes `text` to `filePath` atomically (temp file + rename). */
export const atomicWriteFile = async (filePath, text) => {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await fs.writeFile(tempPath, text, 'utf8');
  await fs.rename(tempPath, filePath);
};

/** Writes `value` to `filePath` as pretty-printed JSON, atomically. */
export const atomicWriteJson = async (filePath, value) => atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);

/** Reads and parses a JSON file, or returns `undefined` if it doesn't exist. */
export const readJsonIfExists = async (filePath) => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
};

/** Reads a text file, or returns `defaultValue` if it doesn't exist. */
export const readTextIfExists = async (filePath, defaultValue = '') => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return defaultValue;
    throw err;
  }
};

/** Whether `dirPath` exists at all (any kind of entry). */
export const pathExists = async (dirPath) => {
  try {
    await fs.access(dirPath);
    return true;
  } catch {
    return false;
  }
};

/** Ensures `dirPath` (and any missing parents) exists. */
export const ensureDir = async (dirPath) => fs.mkdir(dirPath, { recursive: true });

/** Removes a graph's entire directory, if present. A no-op if it isn't. */
export const removeDir = async (dirPath) => fs.rm(dirPath, { recursive: true, force: true });

/**
 * Full paths of every graph directory currently stored in `libraryDir` —
 * the file-based equivalent of "list every row." Deliberately opaque:
 * since the directory name is a digest, not the real hash (see this
 * module's own comment above), a caller that needs a graph's true hash
 * must read it out of that directory's own metadata.json — never try to
 * decode it from the path. Returns an empty array if the library
 * directory doesn't exist yet at all (a brand-new library that's never
 * saved anything).
 */
export const listGraphDirs = async (libraryDir) => {
  let entries;
  try {
    entries = await fs.readdir(libraryDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('graph_'))
    .map((entry) => path.join(libraryDir, entry.name));
};
