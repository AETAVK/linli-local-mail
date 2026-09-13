import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VERSION = 1;
const MAX_MOOV_BYTES = 16 * 1024 * 1024;
const MAX_FTYP_BYTES = 1024 * 1024;
const MAX_UID_SUFFIX_BYTES = 1024;
const MAX_TOP_LEVEL_BOXES = 4096;
const MAX_NESTED_BOXES = 16384;
const MAX_BOX_DEPTH = 16;
const MAX_TABLE_ENTRIES = 1_000_000;
const MAX_SAMPLE_COUNT = 10_000_000;
const MAX_SELECTED_SAMPLES = 300_000;
const MAX_RAW_AAC_PACKET_BYTES = 0x1ff8;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_SECONDS = 10;
const MAX_TRACK_SECONDS = 24 * 60 * 60;
const READ_CHUNK_BYTES = 64 * 1024;
const UID_TAG = Buffer.from("__UID_TAG__", "ascii");
const AAC_SAMPLE_RATES = Object.freeze([
  96000,
  88200,
  64000,
  48000,
  44100,
  32000,
  24000,
  22050,
  16000,
  12000,
  11025,
  8000,
  7350,
]);
const AAC_CHANNELS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 8]);

function audioError(code, phase) {
  const error = new Error(`${code}:${phase}`);
  error.name = "SongAudioError";
  error.code = code;
  error.phase = phase;
  return error;
}

function isAudioError(error) {
  return Boolean(error && error.name === "SongAudioError" && typeof error.code === "string" && typeof error.phase === "string");
}

function fail(code, phase) {
  throw audioError(code, phase);
}

function checkAbort(signal, phase = "abort") {
  if (signal?.aborted === true) fail("SONG_AUDIO_ABORTED", phase);
}

function validateSignal(signal) {
  if (signal === undefined) return;
  if (
    signal === null
    || (typeof signal !== "object" && typeof signal !== "function")
    || typeof signal.aborted !== "boolean"
  ) {
    fail("SONG_AUDIO_INVALID", "arguments");
  }
}

function resolveFilePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) {
    fail("SONG_AUDIO_INVALID", "arguments");
  }
  try {
    return path.resolve(filePath);
  } catch {
    fail("SONG_AUDIO_INVALID", "arguments");
  }
}

function stringStatValue(value, fallback) {
  if (value !== undefined && value !== null) return String(value);
  return String(BigInt(Math.trunc(fallback * 1e6)));
}

function statSignature(stat) {
  return JSON.stringify({
    size: String(stat.size),
    mtimeNs: stringStatValue(stat.mtimeNs, stat.mtimeMs),
    ctimeNs: stringStatValue(stat.ctimeNs, stat.ctimeMs),
    ino: String(stat.ino),
    dev: String(stat.dev),
  });
}

function fingerprintFor(resolved, stat) {
  const identity = JSON.stringify({
    version: VERSION,
    path: resolved,
    size: String(stat.size),
    mtimeNs: stringStatValue(stat.mtimeNs, stat.mtimeMs),
    ino: String(stat.ino),
    dev: String(stat.dev),
  });
  return `v${VERSION}:${crypto.createHash("sha256").update(identity).digest("hex")}`;
}

async function pathState(resolved) {
  let stat;
  try {
    stat = await fs.promises.lstat(resolved, { bigint: true });
  } catch {
    fail("SONG_AUDIO_INVALID", "stat");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail("SONG_AUDIO_INVALID", "stat");
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) fail("SONG_AUDIO_INVALID", "stat");
  return {
    size: Number(stat.size),
    signature: statSignature(stat),
    fingerprint: fingerprintFor(resolved, stat),
  };
}

async function assertUnchanged(resolved, state, handle, signal, phase = "changed") {
  checkAbort(signal);
  let stat;
  try {
    stat = await fs.promises.lstat(resolved, { bigint: true });
  } catch {
    fail("SONG_AUDIO_CHANGED", phase);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || statSignature(stat) !== state.signature) {
    fail("SONG_AUDIO_CHANGED", phase);
  }
  let handleStat;
  try {
    handleStat = await handle.stat({ bigint: true });
  } catch {
    fail("SONG_AUDIO_CHANGED", phase);
  }
  if (!handleStat.isFile() || statSignature(handleStat) !== state.signature) {
    fail("SONG_AUDIO_CHANGED", phase);
  }
  checkAbort(signal);
}

function ensureSafeRange(position, length, limit, phase) {
  if (
    !Number.isSafeInteger(position)
    || !Number.isSafeInteger(length)
    || position < 0
    || length < 0
    || position > limit
    || length > limit - position
  ) {
    fail("SONG_AUDIO_INVALID", phase);
  }
}

async function readExact(handle, length, position, signal, phase) {
  ensureSafeRange(position, length, Number.MAX_SAFE_INTEGER, phase);
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    checkAbort(signal);
    const request = Math.min(READ_CHUNK_BYTES, length - offset);
    let result;
    try {
      result = await handle.read(buffer, offset, request, position + offset);
    } catch {
      fail("SONG_AUDIO_INVALID", phase);
    }
    if (!result || result.bytesRead <= 0) fail("SONG_AUDIO_INVALID", phase);
    offset += result.bytesRead;
  }
  checkAbort(signal);
  return buffer;
}

function isPrintableFourcc(value) {
  return value.length === 4 && [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code <= 0x7e;
  });
}

function parseBufferBox(buffer, offset, end, phase = "boxes") {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || end - offset < 8) {
    fail("SONG_AUDIO_INVALID", phase);
  }
  const size32 = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);
  if (!isPrintableFourcc(type)) fail("SONG_AUDIO_INVALID", phase);
  let headerSize = 8;
  let size;
  if (size32 === 1) {
    if (end - offset < 16) fail("SONG_AUDIO_INVALID", phase);
    const extended = buffer.readBigUInt64BE(offset + 8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) fail("SONG_AUDIO_INVALID", phase);
    size = Number(extended);
    headerSize = 16;
  } else if (size32 === 0) {
    size = end - offset;
  } else {
    size = size32;
  }
  if (!Number.isSafeInteger(size) || size < headerSize || size > end - offset) {
    fail("SONG_AUDIO_INVALID", phase);
  }
  return {
    start: offset,
    end: offset + size,
    size,
    headerSize,
    type,
    bodyStart: offset + headerSize,
  };
}

function parseChildren(buffer, start = 0, end = buffer.length, depth = 0) {
  if (depth > MAX_BOX_DEPTH) fail("SONG_AUDIO_INVALID", "boxes");
  const children = [];
  let offset = start;
  for (let count = 0; offset < end; count += 1) {
    if (count >= MAX_NESTED_BOXES) fail("SONG_AUDIO_INVALID", "boxes");
    if (end - offset < 8) fail("SONG_AUDIO_INVALID", "boxes");
    const box = parseBufferBox(buffer, offset, end);
    children.push(box);
    offset = box.end;
  }
  if (offset !== end) fail("SONG_AUDIO_INVALID", "boxes");
  return children;
}

function boxBody(buffer, box) {
  return buffer.subarray(box.bodyStart, box.end);
}

function singleBox(children, type, required = false) {
  const matches = children.filter((box) => box.type === type);
  if (matches.length > 1) fail("SONG_AUDIO_INVALID", "boxes");
  if (required && matches.length === 0) fail("SONG_AUDIO_INVALID", "boxes");
  return matches[0] ?? null;
}

function parseTopLevelHeader(prefix, offset, fileSize) {
  if (prefix.length < 8) fail("SONG_AUDIO_INVALID", "boxes");
  const size32 = prefix.readUInt32BE(0);
  const type = prefix.toString("ascii", 4, 8);
  if (!isPrintableFourcc(type)) fail("SONG_AUDIO_INVALID", "boxes");
  let headerSize = 8;
  let size;
  if (size32 === 1) {
    if (prefix.length < 16) fail("SONG_AUDIO_INVALID", "boxes");
    const extended = prefix.readBigUInt64BE(8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) fail("SONG_AUDIO_INVALID", "boxes");
    size = Number(extended);
    headerSize = 16;
  } else if (size32 === 0) {
    size = fileSize - offset;
  } else {
    size = size32;
  }
  if (!Number.isSafeInteger(size) || size < headerSize || size > fileSize - offset) {
    fail("SONG_AUDIO_INVALID", "boxes");
  }
  return {
    start: offset,
    end: offset + size,
    size,
    headerSize,
    type,
    bodyStart: offset + headerSize,
  };
}

function validateFtyp(body) {
  if (body.length < 8 || (body.length - 8) % 4 !== 0) fail("SONG_AUDIO_INVALID", "metadata");
  if (!isPrintableFourcc(body.toString("ascii", 0, 4))) fail("SONG_AUDIO_INVALID", "metadata");
  for (let offset = 8; offset < body.length; offset += 4) {
    if (!isPrintableFourcc(body.toString("ascii", offset, offset + 4))) {
      fail("SONG_AUDIO_INVALID", "metadata");
    }
  }
}

async function hasUidSuffix(handle, offset, fileSize, signal) {
  const remaining = fileSize - offset;
  if (remaining < UID_TAG.length || remaining > UID_TAG.length + MAX_UID_SUFFIX_BYTES) return false;
  const marker = await readExact(handle, UID_TAG.length, offset, signal, "boxes");
  return marker.equals(UID_TAG);
}

async function scanContainer(handle, state, signal) {
  let offset = 0;
  let mediaEnd = state.size;
  let ftypSeen = false;
  let moovBody = null;
  let mdatRanges = [];
  let fragmented = false;
  for (let count = 0; offset < state.size; count += 1) {
    checkAbort(signal);
    if (count >= MAX_TOP_LEVEL_BOXES) fail("SONG_AUDIO_INVALID", "boxes");
    if (await hasUidSuffix(handle, offset, state.size, signal)) {
      mediaEnd = offset;
      offset = state.size;
      break;
    }
    if (state.size - offset < 8) fail("SONG_AUDIO_INVALID", "boxes");
    const prefix = await readExact(handle, Math.min(16, state.size - offset), offset, signal, "boxes");
    const box = parseTopLevelHeader(prefix, offset, state.size);
    if (offset === 0 && box.type !== "ftyp") fail("SONG_AUDIO_INVALID", "metadata");
    if (box.type === "ftyp") {
      if (ftypSeen || box.size - box.headerSize > MAX_FTYP_BYTES) fail("SONG_AUDIO_INVALID", "metadata");
      const body = await readExact(handle, box.size - box.headerSize, box.bodyStart, signal, "metadata");
      validateFtyp(body);
      ftypSeen = true;
    } else if (box.type === "moov") {
      if (moovBody !== null || box.size - box.headerSize > MAX_MOOV_BYTES) {
        fail("SONG_AUDIO_INVALID", "metadata");
      }
      moovBody = await readExact(handle, box.size - box.headerSize, box.bodyStart, signal, "metadata");
    } else if (box.type === "mdat") {
      if (box.size > box.headerSize) {
        mdatRanges.push({ start: box.bodyStart, end: box.end });
      }
    } else if (box.type === "moof" || box.type === "mfra") {
      fragmented = true;
    }
    offset = box.end;
  }
  if (offset !== state.size) fail("SONG_AUDIO_INVALID", "boxes");
  if (!ftypSeen || moovBody === null) fail("SONG_AUDIO_INVALID", "metadata");
  if (fragmented) fail("SONG_AUDIO_UNSUPPORTED", "fragmented");
  if (mdatRanges.length === 0) fail("SONG_AUDIO_INVALID", "tables");
  return { moovBody, mdatRanges, mediaEnd };
}

class BitReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  read(bits) {
    if (!Number.isInteger(bits) || bits < 0 || bits > 32 || this.offset + bits > this.buffer.length * 8) {
      fail("SONG_AUDIO_INVALID", "metadata");
    }
    let value = 0;
    for (let index = 0; index < bits; index += 1) {
      const byte = this.buffer[Math.floor(this.offset / 8)];
      const bit = 7 - (this.offset % 8);
      value = (value * 2) + ((byte >> bit) & 1);
      this.offset += 1;
    }
    return value;
  }

  get remaining() {
    return this.buffer.length * 8 - this.offset;
  }
}

function bitsAt(buffer, offset, count) {
  if (offset < 0 || count < 0 || offset + count > buffer.length * 8) return null;
  let value = 0;
  for (let index = 0; index < count; index += 1) {
    const byte = buffer[Math.floor((offset + index) / 8)];
    const bit = 7 - ((offset + index) % 8);
    value = (value * 2) + ((byte >> bit) & 1);
  }
  return value;
}

function audioObjectType(reader) {
  const type = reader.read(5);
  if (type !== 31) return type;
  return 32 + reader.read(6);
}

function parseAudioSpecificConfig(buffer) {
  if (buffer.length === 0) fail("SONG_AUDIO_INVALID", "metadata");
  const reader = new BitReader(buffer);
  const objectType = audioObjectType(reader);
  if (objectType !== 2) fail("SONG_AUDIO_UNSUPPORTED", "codec");
  const frequencyIndex = reader.read(4);
  let sampleRate;
  if (frequencyIndex === 15) {
    sampleRate = reader.read(24);
    if (!AAC_SAMPLE_RATES.includes(sampleRate)) fail("SONG_AUDIO_UNSUPPORTED", "codec");
  } else if (frequencyIndex < AAC_SAMPLE_RATES.length) {
    sampleRate = AAC_SAMPLE_RATES[frequencyIndex];
  } else {
    fail("SONG_AUDIO_UNSUPPORTED", "codec");
  }
  const channelConfiguration = reader.read(4);
  const channels = AAC_CHANNELS[channelConfiguration];
  if (!channels) fail("SONG_AUDIO_UNSUPPORTED", "codec");
  const frameLengthFlag = reader.read(1);
  const dependsOnCoreCoder = reader.read(1);
  if (dependsOnCoreCoder) reader.read(14);
  const extensionFlag = reader.read(1);
  if (extensionFlag) fail("SONG_AUDIO_UNSUPPORTED", "codec");

  for (let offset = reader.offset; offset + 16 <= buffer.length * 8; offset += 1) {
    if (bitsAt(buffer, offset, 11) !== 0x2b7) continue;
    const extensionType = bitsAt(buffer, offset + 11, 5);
    const sbrPresent = bitsAt(buffer, offset + 16, 1);
    if ((extensionType === 5 || extensionType === 29) && sbrPresent === 1) {
      fail("SONG_AUDIO_UNSUPPORTED", "codec");
    }
  }

  return {
    objectType,
    sampleRate,
    frequencyIndex: frequencyIndex === 15 ? AAC_SAMPLE_RATES.indexOf(sampleRate) : frequencyIndex,
    channelConfiguration,
    channels,
    frameLengthFlag,
  };
}

function readDescriptor(buffer, offset, end) {
  if (offset >= end) fail("SONG_AUDIO_INVALID", "metadata");
  const tag = buffer[offset];
  let cursor = offset + 1;
  let length = 0;
  let complete = false;
  for (let index = 0; index < 4; index += 1) {
    if (cursor >= end) fail("SONG_AUDIO_INVALID", "metadata");
    const value = buffer[cursor];
    cursor += 1;
    length = (length * 128) + (value & 0x7f);
    if (length > end - cursor) fail("SONG_AUDIO_INVALID", "metadata");
    if ((value & 0x80) === 0) {
      complete = true;
      break;
    }
  }
  if (!complete || length > end - cursor) fail("SONG_AUDIO_INVALID", "metadata");
  return { tag, body: buffer.subarray(cursor, cursor + length), next: cursor + length };
}

function descriptorsIn(buffer, start, end) {
  const descriptors = [];
  let offset = start;
  for (let count = 0; offset < end; count += 1) {
    if (count >= MAX_NESTED_BOXES) fail("SONG_AUDIO_INVALID", "metadata");
    const descriptor = readDescriptor(buffer, offset, end);
    descriptors.push(descriptor);
    offset = descriptor.next;
  }
  return descriptors;
}

function oneDescriptor(descriptors, tag) {
  const matches = descriptors.filter((descriptor) => descriptor.tag === tag);
  if (matches.length !== 1) fail("SONG_AUDIO_INVALID", "metadata");
  return matches[0];
}

function parseEsds(body) {
  if (body.length < 4) fail("SONG_AUDIO_INVALID", "metadata");
  const top = descriptorsIn(body, 4, body.length);
  const es = oneDescriptor(top, 0x03);
  if (es.body.length < 3) fail("SONG_AUDIO_INVALID", "metadata");
  const esFlags = es.body[2];
  let offset = 3;
  if (esFlags & 0x80) offset += 2;
  if (esFlags & 0x40) {
    if (offset >= es.body.length) fail("SONG_AUDIO_INVALID", "metadata");
    offset += 1 + es.body[offset];
  }
  if (esFlags & 0x20) offset += 2;
  if (offset > es.body.length) fail("SONG_AUDIO_INVALID", "metadata");
  const nested = descriptorsIn(es.body, offset, es.body.length);
  const decoderConfig = oneDescriptor(nested, 0x04);
  if (decoderConfig.body.length < 13) fail("SONG_AUDIO_INVALID", "metadata");
  const objectTypeIndication = decoderConfig.body[0];
  const streamType = decoderConfig.body[1];
  if (objectTypeIndication !== 0x40 || ((streamType >> 2) & 0x3f) !== 5 || (streamType & 1) !== 1) {
    fail("SONG_AUDIO_UNSUPPORTED", "codec");
  }
  const configDescriptors = descriptorsIn(decoderConfig.body, 13, decoderConfig.body.length);
  const specificInfo = oneDescriptor(configDescriptors, 0x05);
  return parseAudioSpecificConfig(specificInfo.body);
}

function parseStsd(body) {
  if (body.length < 8) fail("SONG_AUDIO_INVALID", "tables");
  const entryCount = body.readUInt32BE(4);
  if (entryCount === 0 || entryCount > MAX_TABLE_ENTRIES) fail("SONG_AUDIO_INVALID", "tables");
  if (entryCount !== 1) fail("SONG_AUDIO_UNSUPPORTED", "codec");
  const entry = parseBufferBox(body, 8, body.length, "tables");
  if (entry.end !== body.length) fail("SONG_AUDIO_INVALID", "tables");
  if (entry.type !== "mp4a") fail("SONG_AUDIO_UNSUPPORTED", "codec");
  const entryBody = boxBody(body, entry);
  if (entryBody.length < 28) fail("SONG_AUDIO_INVALID", "tables");
  if (entryBody.readUInt16BE(8) !== 0) fail("SONG_AUDIO_UNSUPPORTED", "codec");
  const channels = entryBody.readUInt16BE(16);
  const fixedRate = entryBody.readUInt32BE(24);
  const entryRate = fixedRate / 65536;
  if (channels < 1 || channels > 8 || !Number.isInteger(entryRate) || entryRate <= 0) {
    fail("SONG_AUDIO_INVALID", "metadata");
  }
  const children = parseChildren(entryBody, 28, entryBody.length, 1);
  if (singleBox(children, "sinf", false)) fail("SONG_AUDIO_UNSUPPORTED", "codec");
  const esds = singleBox(children, "esds", true);
  const config = parseEsds(boxBody(entryBody, esds));
  if (config.sampleRate !== entryRate || config.channels !== channels) {
    fail("SONG_AUDIO_INVALID", "metadata");
  }
  return config;
}

function parseMdhd(body) {
  if (body.length < 4) fail("SONG_AUDIO_INVALID", "metadata");
  const version = body[0];
  let timescale;
  if (version === 0) {
    if (body.length < 20) fail("SONG_AUDIO_INVALID", "metadata");
    timescale = body.readUInt32BE(12);
  } else if (version === 1) {
    if (body.length < 32) fail("SONG_AUDIO_INVALID", "metadata");
    timescale = body.readUInt32BE(20);
  } else {
    fail("SONG_AUDIO_INVALID", "metadata");
  }
  if (timescale === 0) fail("SONG_AUDIO_INVALID", "metadata");
  return timescale;
}

function parseStts(body) {
  if (body.length < 8) fail("SONG_AUDIO_INVALID", "tables");
  const entryCount = body.readUInt32BE(4);
  if (entryCount === 0 || entryCount > MAX_TABLE_ENTRIES || body.length !== 8 + entryCount * 8) {
    fail("SONG_AUDIO_INVALID", "tables");
  }
  const counts = new Uint32Array(entryCount);
  const deltas = new Uint32Array(entryCount);
  let sampleCountBig = 0n;
  let durationTicksBig = 0n;
  let offset = 8;
  for (let index = 0; index < entryCount; index += 1) {
    const count = body.readUInt32BE(offset);
    const delta = body.readUInt32BE(offset + 4);
    if (count === 0 || delta === 0) fail("SONG_AUDIO_INVALID", "tables");
    counts[index] = count;
    deltas[index] = delta;
    sampleCountBig += BigInt(count);
    durationTicksBig += BigInt(count) * BigInt(delta);
    offset += 8;
  }
  if (sampleCountBig === 0n || sampleCountBig > BigInt(MAX_SAMPLE_COUNT) || durationTicksBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("SONG_AUDIO_INVALID", "tables");
  }
  return {
    counts,
    deltas,
    sampleCount: Number(sampleCountBig),
    durationTicks: Number(durationTicksBig),
  };
}

function parseStsc(body) {
  if (body.length < 8) fail("SONG_AUDIO_INVALID", "tables");
  const entryCount = body.readUInt32BE(4);
  if (entryCount === 0 || entryCount > MAX_TABLE_ENTRIES || body.length !== 8 + entryCount * 12) {
    fail("SONG_AUDIO_INVALID", "tables");
  }
  const firstChunks = new Uint32Array(entryCount);
  const samplesPerChunk = new Uint32Array(entryCount);
  const descriptionIndexes = new Uint32Array(entryCount);
  let offset = 8;
  for (let index = 0; index < entryCount; index += 1) {
    firstChunks[index] = body.readUInt32BE(offset);
    samplesPerChunk[index] = body.readUInt32BE(offset + 4);
    descriptionIndexes[index] = body.readUInt32BE(offset + 8);
    if (firstChunks[index] === 0 || samplesPerChunk[index] === 0 || descriptionIndexes[index] !== 1) {
      fail("SONG_AUDIO_INVALID", "tables");
    }
    if (index > 0 && firstChunks[index] <= firstChunks[index - 1]) {
      fail("SONG_AUDIO_INVALID", "tables");
    }
    offset += 12;
  }
  return { firstChunks, samplesPerChunk, descriptionIndexes };
}

function parseStsz(body) {
  if (body.length < 12) fail("SONG_AUDIO_INVALID", "tables");
  const constantSize = body.readUInt32BE(4);
  const sampleCount = body.readUInt32BE(8);
  if (sampleCount === 0 || sampleCount > MAX_SAMPLE_COUNT) fail("SONG_AUDIO_INVALID", "tables");
  if (constantSize === 0) {
    if (body.length !== 12 + sampleCount * 4) fail("SONG_AUDIO_INVALID", "tables");
    const sizes = body.subarray(12);
    for (let offset = 0; offset < sizes.length; offset += 4) {
      if (sizes.readUInt32BE(offset) === 0) fail("SONG_AUDIO_INVALID", "tables");
    }
    return { constantSize: 0, sampleCount, sizes };
  }
  if (body.length !== 12) fail("SONG_AUDIO_INVALID", "tables");
  return { constantSize, sampleCount, sizes: null };
}

function parseChunkOffsets(body, kind) {
  if (body.length < 8) fail("SONG_AUDIO_INVALID", "tables");
  const count = body.readUInt32BE(4);
  const width = kind === "co64" ? 8 : 4;
  if (count === 0 || count > MAX_TABLE_ENTRIES || body.length !== 8 + count * width) {
    fail("SONG_AUDIO_INVALID", "tables");
  }
  return { kind, count, data: body.subarray(8) };
}

function chunkOffsetAt(table, index) {
  if (!Number.isInteger(index) || index < 0 || index >= table.count) fail("SONG_AUDIO_INVALID", "tables");
  if (table.kind === "stco") return table.data.readUInt32BE(index * 4);
  const offset = table.data.readBigUInt64BE(index * 8);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) fail("SONG_AUDIO_INVALID", "tables");
  return Number(offset);
}

function sampleSizeAt(table, index) {
  if (!Number.isInteger(index) || index < 0 || index >= table.sampleCount) fail("SONG_AUDIO_INVALID", "tables");
  if (table.constantSize !== 0) return table.constantSize;
  return table.sizes.readUInt32BE(index * 4);
}

function buildChunkRuns(stsc, chunkCount, sampleCount) {
  if (stsc.firstChunks[0] !== 1) fail("SONG_AUDIO_INVALID", "tables");
  const runs = [];
  let sampleIndex = 0;
  for (let index = 0; index < stsc.firstChunks.length; index += 1) {
    const firstChunk = stsc.firstChunks[index];
    const lastChunk = index + 1 < stsc.firstChunks.length
      ? stsc.firstChunks[index + 1] - 1
      : chunkCount;
    if (lastChunk < firstChunk || lastChunk > chunkCount) fail("SONG_AUDIO_INVALID", "tables");
    const chunkTotal = lastChunk - firstChunk + 1;
    const samplesInRunBig = BigInt(chunkTotal) * BigInt(stsc.samplesPerChunk[index]);
    if (samplesInRunBig > BigInt(Number.MAX_SAFE_INTEGER)) fail("SONG_AUDIO_INVALID", "tables");
    const fullSamplesInRun = Number(samplesInRunBig);
    const remainingSamples = sampleCount - sampleIndex;
    if (remainingSamples <= 0 || (fullSamplesInRun > remainingSamples && index + 1 < stsc.firstChunks.length)) {
      fail("SONG_AUDIO_INVALID", "tables");
    }
    const samplesInRun = Math.min(fullSamplesInRun, remainingSamples);
    runs.push({
      firstChunk,
      lastChunk,
      samplesPerChunk: stsc.samplesPerChunk[index],
      firstSampleIndex: sampleIndex,
    });
    sampleIndex += samplesInRun;
  }
  if (sampleIndex !== sampleCount) fail("SONG_AUDIO_INVALID", "tables");
  return runs;
}

function mdatContains(ranges, offset, size, mediaEnd) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size <= 0) return false;
  if (offset >= mediaEnd || size > mediaEnd - offset) return false;
  return ranges.some((range) => offset >= range.start && offset + size <= range.end);
}

function eachSampleLocation(track, startIndex, endIndex, callback) {
  if (startIndex < 0 || endIndex < startIndex || endIndex > track.sampleCount) {
    fail("SONG_AUDIO_INVALID", "tables");
  }
  for (const run of track.chunkRuns) {
    const runEnd = run.firstSampleIndex + (run.lastChunk - run.firstChunk + 1) * run.samplesPerChunk;
    const overlapStart = Math.max(startIndex, run.firstSampleIndex);
    const overlapEnd = Math.min(endIndex, runEnd, track.sampleCount);
    if (overlapStart >= overlapEnd) continue;
    const firstChunkWithin = Math.floor((overlapStart - run.firstSampleIndex) / run.samplesPerChunk);
    const lastChunkWithin = Math.floor((overlapEnd - 1 - run.firstSampleIndex) / run.samplesPerChunk);
    for (let chunkWithin = firstChunkWithin; chunkWithin <= lastChunkWithin; chunkWithin += 1) {
      const chunkNumber = run.firstChunk + chunkWithin;
      const chunkStartIndex = run.firstSampleIndex + chunkWithin * run.samplesPerChunk;
      const chunkEndIndex = Math.min(chunkStartIndex + run.samplesPerChunk, track.sampleCount);
      let offset = chunkOffsetAt(track.chunkOffsets, chunkNumber - 1);
      for (let sampleIndex = chunkStartIndex; sampleIndex < chunkEndIndex; sampleIndex += 1) {
        const size = sampleSizeAt(track.sampleSizes, sampleIndex);
        if (sampleIndex >= overlapStart && sampleIndex < overlapEnd) callback({ sampleIndex, offset, size });
        if (!Number.isSafeInteger(offset) || size > Number.MAX_SAFE_INTEGER - offset) {
          fail("SONG_AUDIO_INVALID", "tables");
        }
        offset += size;
      }
    }
  }
}

function validateTrackLayout(track, mdatRanges, mediaEnd) {
  eachSampleLocation(track, 0, track.sampleCount, ({ offset, size }) => {
    if (size > MAX_RAW_AAC_PACKET_BYTES) fail("SONG_AUDIO_UNSUPPORTED", "codec");
    if (!mdatContains(mdatRanges, offset, size, mediaEnd)) fail("SONG_AUDIO_INVALID", "tables");
  });
}

function handlerType(body) {
  if (body.length < 12) fail("SONG_AUDIO_INVALID", "metadata");
  return body.toString("ascii", 8, 12);
}

function parseAudioTrack(trakBody) {
  const trakChildren = parseChildren(trakBody, 0, trakBody.length, 1);
  const mdia = singleBox(trakChildren, "mdia", false);
  if (!mdia) return null;
  const mdiaBody = boxBody(trakBody, mdia);
  const mdiaChildren = parseChildren(mdiaBody, 0, mdiaBody.length, 2);
  const hdlr = singleBox(mdiaChildren, "hdlr", false);
  if (!hdlr || handlerType(boxBody(mdiaBody, hdlr)) !== "soun") return null;
  const mdhd = singleBox(mdiaChildren, "mdhd", true);
  const minf = singleBox(mdiaChildren, "minf", true);
  const timescale = parseMdhd(boxBody(mdiaBody, mdhd));
  const minfBody = boxBody(mdiaBody, minf);
  const minfChildren = parseChildren(minfBody, 0, minfBody.length, 3);
  const stbl = singleBox(minfChildren, "stbl", true);
  const stblBody = boxBody(minfBody, stbl);
  const stblChildren = parseChildren(stblBody, 0, stblBody.length, 4);
  if (stblChildren.some((box) => box.type === "senc" || box.type === "saiz" || box.type === "saio")) {
    fail("SONG_AUDIO_UNSUPPORTED", "codec");
  }
  const stsd = singleBox(stblChildren, "stsd", true);
  const stts = singleBox(stblChildren, "stts", true);
  const stsc = singleBox(stblChildren, "stsc", true);
  const stsz = singleBox(stblChildren, "stsz", true);
  const stco = singleBox(stblChildren, "stco", false);
  const co64 = singleBox(stblChildren, "co64", false);
  if ((stco && co64) || (!stco && !co64)) fail("SONG_AUDIO_INVALID", "tables");
  const config = parseStsd(boxBody(stblBody, stsd));
  const timing = parseStts(boxBody(stblBody, stts));
  const scaling = parseStsc(boxBody(stblBody, stsc));
  const sizes = parseStsz(boxBody(stblBody, stsz));
  if (timing.sampleCount !== sizes.sampleCount) fail("SONG_AUDIO_INVALID", "tables");
  const chunkOffsets = parseChunkOffsets(boxBody(stblBody, stco ?? co64), co64 ? "co64" : "stco");
  const chunkRuns = buildChunkRuns(scaling, chunkOffsets.count, sizes.sampleCount);
  const durationSeconds = timing.durationTicks / timescale;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_TRACK_SECONDS) {
    fail("SONG_AUDIO_INVALID", "tables");
  }
  return {
    timescale,
    sampleRate: config.sampleRate,
    channels: config.channels,
    frequencyIndex: config.frequencyIndex,
    channelConfiguration: config.channelConfiguration,
    sampleCount: sizes.sampleCount,
    durationTicks: timing.durationTicks,
    durationSeconds,
    stts: timing,
    sampleSizes: sizes,
    chunkOffsets,
    chunkRuns,
  };
}

function parseTrack(moovBody) {
  const moovChildren = parseChildren(moovBody, 0, moovBody.length, 0);
  if (singleBox(moovChildren, "mvex", false)) fail("SONG_AUDIO_UNSUPPORTED", "fragmented");
  const tracks = moovChildren.filter((box) => box.type === "trak");
  if (tracks.length === 0) fail("SONG_AUDIO_INVALID", "metadata");
  const audioTracks = [];
  for (const trak of tracks) {
    const track = parseAudioTrack(boxBody(moovBody, trak));
    if (track) audioTracks.push(track);
  }
  if (audioTracks.length === 0) fail("SONG_AUDIO_INVALID", "metadata");
  if (audioTracks.length !== 1) fail("SONG_AUDIO_UNSUPPORTED", "codec");
  return audioTracks[0];
}

function readSampleStart(track, sampleIndex) {
  if (!Number.isInteger(sampleIndex) || sampleIndex < 0 || sampleIndex >= track.sampleCount) {
    fail("SONG_AUDIO_INVALID", "tables");
  }
  let sampleBase = 0;
  let tickBase = 0;
  for (let index = 0; index < track.stts.counts.length; index += 1) {
    const count = track.stts.counts[index];
    if (sampleIndex < sampleBase + count) {
      return tickBase + (sampleIndex - sampleBase) * track.stts.deltas[index];
    }
    sampleBase += count;
    tickBase += count * track.stts.deltas[index];
  }
  fail("SONG_AUDIO_INVALID", "tables");
}

function firstSampleEndingAfter(track, tick) {
  let sampleBase = 0;
  let tickBase = 0;
  for (let index = 0; index < track.stts.counts.length; index += 1) {
    const count = track.stts.counts[index];
    const delta = track.stts.deltas[index];
    const runEnd = tickBase + count * delta;
    if (tick < runEnd) {
      const relative = tick <= tickBase ? 0 : Math.floor((tick - tickBase) / delta);
      return Math.min(sampleBase + relative, track.sampleCount - 1);
    }
    sampleBase += count;
    tickBase = runEnd;
  }
  return track.sampleCount;
}

function firstSampleStartingAtOrAfter(track, tick) {
  if (tick <= 0) return 0;
  let sampleBase = 0;
  let tickBase = 0;
  for (let index = 0; index < track.stts.counts.length; index += 1) {
    const count = track.stts.counts[index];
    const delta = track.stts.deltas[index];
    const runEnd = tickBase + count * delta;
    if (tick <= tickBase) return sampleBase;
    if (tick < runEnd) {
      const relative = Math.ceil((tick - tickBase) / delta);
      return Math.min(sampleBase + relative, track.sampleCount);
    }
    sampleBase += count;
    tickBase = runEnd;
  }
  return track.sampleCount;
}

function selectSamples(track, startSeconds, durationSeconds) {
  const startExact = startSeconds * track.timescale;
  const endExact = (startSeconds + durationSeconds) * track.timescale;
  if (!Number.isFinite(startExact) || !Number.isFinite(endExact)) fail("SONG_AUDIO_INVALID", "arguments");
  const startTick = Math.max(0, Math.min(track.durationTicks - 1, Math.floor(startExact + 1e-9)));
  const endTick = Math.min(track.durationTicks, Math.max(startTick + 1, Math.ceil(endExact - 1e-9)));
  const first = firstSampleEndingAfter(track, startTick);
  const exclusive = Math.max(first + 1, firstSampleStartingAtOrAfter(track, endTick));
  if (first >= track.sampleCount || exclusive <= first) fail("SONG_AUDIO_INVALID", "arguments");
  const actualStartTick = readSampleStart(track, first);
  const actualEndTick = exclusive >= track.sampleCount
    ? track.durationTicks
    : readSampleStart(track, exclusive);
  const actualDuration = (actualEndTick - actualStartTick) / track.timescale;
  if (!Number.isFinite(actualDuration) || actualDuration <= 0 || actualDuration > 12) {
    fail("SONG_AUDIO_INVALID", "output");
  }
  return {
    first,
    exclusive,
    startSeconds: actualStartTick / track.timescale,
    durationSeconds: actualDuration,
  };
}

function adtsHeader(rawLength, track) {
  const frameLength = rawLength + 7;
  if (rawLength <= 0 || frameLength > 0x1fff) fail("SONG_AUDIO_UNSUPPORTED", "output");
  const header = Buffer.alloc(7);
  header[0] = 0xff;
  header[1] = 0xf1;
  header[2] = ((2 - 1) << 6) | (track.frequencyIndex << 2) | ((track.channelConfiguration >> 2) & 1);
  header[3] = ((track.channelConfiguration & 3) << 6) | ((frameLength >> 11) & 3);
  header[4] = (frameLength >> 3) & 0xff;
  header[5] = ((frameLength & 7) << 5) | 0x1f;
  header[6] = 0xfc;
  return header;
}

async function withParsedTrack(filePath, options, operation) {
  const resolved = resolveFilePath(filePath);
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("SONG_AUDIO_INVALID", "arguments");
  const signal = options.signal;
  validateSignal(signal);
  checkAbort(signal);
  const state = await pathState(resolved);
  let handle;
  try {
    try {
      handle = await fs.promises.open(resolved, "r");
    } catch {
      fail("SONG_AUDIO_INVALID", "open");
    }
    await assertUnchanged(resolved, state, handle, signal, "changed");
    const container = await scanContainer(handle, state, signal);
    const track = parseTrack(container.moovBody);
    validateTrackLayout(track, container.mdatRanges, container.mediaEnd);
    const result = await operation({ handle, state, track, signal });
    await assertUnchanged(resolved, state, handle, signal, "changed");
    return result;
  } catch (error) {
    if (isAudioError(error)) throw error;
    if (signal?.aborted === true) throw audioError("SONG_AUDIO_ABORTED", "abort");
    throw audioError("SONG_AUDIO_INVALID", "read");
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // A close failure must not expose a native path or file error.
      }
    }
  }
}

function readExtractionOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("SONG_AUDIO_INVALID", "arguments");
  const startSeconds = options.startSeconds ?? 0;
  const durationSeconds = options.durationSeconds ?? MAX_REQUEST_SECONDS;
  if (
    typeof startSeconds !== "number"
    || !Number.isFinite(startSeconds)
    || startSeconds < 0
    || startSeconds > MAX_TRACK_SECONDS
    || typeof durationSeconds !== "number"
    || !Number.isFinite(durationSeconds)
    || durationSeconds <= 0
    || durationSeconds > MAX_REQUEST_SECONDS
  ) {
    fail("SONG_AUDIO_INVALID", "arguments");
  }
  return { startSeconds, durationSeconds };
}

export async function probeAacTrack(filePath, options = {}) {
  return withParsedTrack(filePath, options, async ({ state, track }) => ({
    durationSeconds: track.durationSeconds,
    sampleRate: track.sampleRate,
    channels: track.channels,
    fingerprint: state.fingerprint,
  }));
}

export async function extractAacSample(filePath, options = {}) {
  const { startSeconds, durationSeconds } = readExtractionOptions(options);
  return withParsedTrack(filePath, options, async ({ handle, state, track, signal }) => {
    if (startSeconds >= track.durationSeconds) fail("SONG_AUDIO_INVALID", "arguments");
    const selection = selectSamples(track, startSeconds, durationSeconds);
    const locations = [];
    let outputLength = 0;
    eachSampleLocation(track, selection.first, selection.exclusive, (location) => {
      if (locations.length >= MAX_SELECTED_SAMPLES) fail("SONG_AUDIO_INVALID", "output");
      const frameLength = location.size + 7;
      if (!Number.isSafeInteger(frameLength) || frameLength > MAX_OUTPUT_BYTES - outputLength) {
        fail("SONG_AUDIO_INVALID", "output");
      }
      locations.push(location);
      outputLength += frameLength;
    });
    if (locations.length === 0 || outputLength <= 0 || outputLength > MAX_OUTPUT_BYTES) {
      fail("SONG_AUDIO_INVALID", "output");
    }
    const output = Buffer.alloc(outputLength);
    let outputOffset = 0;
    for (const location of locations) {
      checkAbort(signal);
      const raw = await readExact(handle, location.size, location.offset, signal, "audio");
      const header = adtsHeader(location.size, track);
      header.copy(output, outputOffset);
      outputOffset += header.length;
      raw.copy(output, outputOffset);
      outputOffset += raw.length;
    }
    checkAbort(signal);
    return {
      buffer: output,
      mimeType: "audio/aac",
      startSeconds: selection.startSeconds,
      durationSeconds: selection.durationSeconds,
      sourceFingerprint: state.fingerprint,
    };
  });
}
