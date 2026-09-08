import crypto from 'node:crypto';
import path from 'node:path';
import { lstat as defaultLstat, readdir as defaultReaddir } from 'node:fs/promises';

const SONG_DIRECTORY = /^midi_[0-9]+_[0-9]+$/;
const DEFAULT_MAX_ENTRIES = 50_000;

/**
 * Build a content-free fingerprint for the local custom-song inputs.
 *
 * Only lstat and readdir are used.  The media root is sampled one level deep
 * for matching midi directories, and those directories are sampled one level
 * deep for their direct entries.  The log root is sampled one level deep.
 * `maxEntries` is a global budget for records returned by readdir (and the
 * root records themselves), so an unexpectedly large directory cannot cause
 * unbounded descent.  A truncated or failed sample is never cacheable.
 */
export async function fingerprintCustomSongInputs({ mediaRoot, logRoot, maxEntries = DEFAULT_MAX_ENTRIES, io } = {}) {
  const fileSystem = {
    lstat: typeof io?.lstat === 'function' ? io.lstat : defaultLstat,
    readdir: typeof io?.readdir === 'function' ? io.readdir : defaultReaddir,
  };
  const state = {
    remaining: normaliseBudget(maxEntries),
    cacheable: true,
    truncated: false,
    records: [],
  };
  const roots = {
    media: await sampleMediaRoot(mediaRoot, fileSystem, state),
    logs: await sampleLogRoot(logRoot, fileSystem, state),
  };

  state.records.sort(compareRecords);
  const payload = {
    version: 1,
    roots,
    records: state.records,
    truncated: state.truncated,
  };
  const signature = `v1:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
  return {
    signature,
    cacheable: state.cacheable && !state.truncated,
    entries: state.records.length,
  };
}

async function sampleMediaRoot(root, fileSystem, state) {
  const identity = rootIdentity(root);
  const result = { identity, status: 'missing', metadata: null };
  if (!identity) {
    state.cacheable = false;
    result.status = 'missing';
    addRecord(state, 'media', '<root>', { type: 'missing', size: null, mtimeMs: null, ctimeMs: null, inode: null, dev: null });
    return result;
  }

  let info;
  try {
    info = await fileSystem.lstat(root);
  } catch (error) {
    state.cacheable = false;
    result.status = error?.code === 'ENOENT' ? 'missing' : 'error';
    result.error = errorCode(error);
    addRecord(state, 'media', '<root>', { type: result.status, size: null, mtimeMs: null, ctimeMs: null, inode: null, dev: null });
    return result;
  }

  const metadata = describeStat(info);
  result.metadata = metadata;
  result.status = metadata.type === 'directory' ? 'readable' : 'invalid';
  addRecord(state, 'media', '<root>', metadata);
  if (metadata.type !== 'directory') {
    state.cacheable = false;
    return result;
  }

  await sampleMediaDirectory(root, fileSystem, state);
  return result;
}

async function sampleMediaDirectory(root, fileSystem, state) {
  const entries = await readDirectory(root, fileSystem, state, 'media');
  if (!entries) return;

  for (const entry of entries) {
    if (!SONG_DIRECTORY.test(entry.name)) continue;
    const target = path.join(root, entry.name);
    const metadata = await statEntry(target, fileSystem, state, 'media', entry.name, true);
    if (!metadata) continue;
    if (metadata.type !== 'directory' || metadata.type === 'symlink') continue;
    await sampleSongDirectory(target, entry.name, fileSystem, state);
  }
}

async function sampleSongDirectory(directory, name, fileSystem, state) {
  const entries = await readDirectory(directory, fileSystem, state, `media/${name}`);
  if (!entries) return;
  for (const entry of entries) {
    await statEntry(path.join(directory, entry.name), fileSystem, state, `media/${name}`, `${name}/${entry.name}`, true);
  }
}

async function sampleLogRoot(root, fileSystem, state) {
  const identity = rootIdentity(root);
  const result = { identity, status: 'missing', metadata: null };
  if (!identity) {
    // An omitted optional log root is a stable absent-log state.  The media
    // root still determines whether the overall result can be cached.
    result.status = 'missing';
    addRecord(state, 'logs', '<root>', { type: 'missing', size: null, mtimeMs: null, ctimeMs: null, inode: null, dev: null });
    return result;
  }

  let info;
  try {
    info = await fileSystem.lstat(root);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      result.status = 'missing';
      result.error = 'ENOENT';
      addRecord(state, 'logs', '<root>', { type: 'missing', size: null, mtimeMs: null, ctimeMs: null, inode: null, dev: null });
      return result;
    }
    state.cacheable = false;
    result.status = 'error';
    result.error = errorCode(error);
    addRecord(state, 'logs', '<root>', { type: 'error', size: null, mtimeMs: null, ctimeMs: null, inode: null, dev: null });
    return result;
  }

  const metadata = describeStat(info);
  result.metadata = metadata;
  result.status = metadata.type === 'directory' ? 'readable' : 'invalid';
  addRecord(state, 'logs', '<root>', metadata);
  if (metadata.type !== 'directory') {
    state.cacheable = false;
    return result;
  }

  const entries = await readDirectory(root, fileSystem, state, 'logs');
  if (!entries) return result;
  for (const entry of entries) {
    await statEntry(path.join(root, entry.name), fileSystem, state, 'logs', entry.name, true);
  }
  return result;
}

async function readDirectory(directory, fileSystem, state, scope) {
  let rawEntries;
  try {
    rawEntries = await fileSystem.readdir(directory, { withFileTypes: true });
  } catch (error) {
    state.cacheable = false;
    addRecord(state, scope, '<read-error>', { type: 'error', size: null, mtimeMs: null, ctimeMs: null, inode: null, dev: null,
      error: errorCode(error) });
    return null;
  }

  if (!Array.isArray(rawEntries)) {
    state.cacheable = false;
    addRecord(state, scope, '<read-error>', { type: 'error', size: null, mtimeMs: null, ctimeMs: null, inode: null, dev: null,
      error: 'INVALID_READ_RESULT' });
    return null;
  }

  const entries = rawEntries.map((entry) => ({
    name: typeof entry === 'string' ? entry : entry?.name,
  })).filter((entry) => typeof entry.name === 'string');
  entries.sort((left, right) => compareNames(left.name, right.name));
  if (entries.length > state.remaining) state.truncated = true;
  const selected = entries.slice(0, state.remaining);
  state.remaining -= selected.length;
  if (selected.length < entries.length) state.cacheable = false;
  return selected;
}

async function statEntry(target, fileSystem, state, scope, name, reserved = false) {
  let info;
  try {
    info = await fileSystem.lstat(target);
  } catch (error) {
    state.cacheable = false;
    addRecord(state, scope, name, { type: 'error', size: null, mtimeMs: null, ctimeMs: null, inode: null, dev: null,
      error: errorCode(error) }, reserved);
    return null;
  }
  const metadata = describeStat(info);
  addRecord(state, scope, name, metadata, reserved);
  return metadata;
}

function addRecord(state, scope, name, metadata, reserved = false) {
  // Root records are included in the same bounded inventory as directory
  // entries.  This keeps the returned entry count within the global budget.
  if (!reserved && state.remaining <= 0) {
    state.truncated = true;
    state.cacheable = false;
    return false;
  }
  if (!reserved) state.remaining -= 1;
  state.records.push({ scope, name, ...metadata });
  return true;
}

function describeStat(info) {
  const symbolicLink = callStatFlag(info, 'isSymbolicLink');
  const directory = !symbolicLink && callStatFlag(info, 'isDirectory');
  const file = !symbolicLink && callStatFlag(info, 'isFile');
  return {
    type: symbolicLink ? 'symlink' : directory ? 'directory' : file ? 'file' : 'other',
    size: statValue(info?.size),
    mtimeMs: statValue(info?.mtimeMs),
    ctimeMs: statValue(info?.ctimeMs),
    mtimeNs: statValue(info?.mtimeNs),
    ctimeNs: statValue(info?.ctimeNs),
    inode: statValue(info?.ino),
    dev: statValue(info?.dev),
  };
}

function callStatFlag(info, method) {
  try {
    return typeof info?.[method] === 'function' && info[method]();
  } catch {
    return false;
  }
}

function statValue(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'bigint' ? value.toString() : value;
}

function rootIdentity(root) {
  if (typeof root !== 'string' || root.length === 0) return null;
  return path.resolve(root);
}

function errorCode(error) {
  return typeof error?.code === 'string' && error.code ? error.code : 'UNKNOWN';
}

function normaliseBudget(value) {
  if (!Number.isFinite(value)) return DEFAULT_MAX_ENTRIES;
  return Math.max(0, Math.floor(value));
}

function compareRecords(left, right) {
  const scope = compareNames(left.scope, right.scope);
  return scope || compareNames(left.name, right.name);
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
