import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VERSION = 1;
const MAX_METADATA_BYTES = 16 * 1024 ** 2;
const MAX_FTYP_BYTES = 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 4096;
const MAX_NESTED_BOXES = 16384;
const DEFAULT_HASH_BUDGET = 32 * 1024 ** 3;
const UID_TAG = Buffer.from("__UID_TAG__", "ascii");
const MAX_UID_SUFFIX_BYTES = UID_TAG.length + 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;

const isPrintableFourcc = (value) => value.length === 4 && [...value].every((char) => {
  const code = char.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e;
});

const fingerprintFor = (resolved, stat) => {
  const identity = JSON.stringify({
    path: resolved,
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs ?? BigInt(Math.trunc(stat.mtimeMs * 1e6))),
    ctimeNs: String(stat.ctimeNs ?? BigInt(Math.trunc(stat.ctimeMs * 1e6))),
    inode: String(stat.ino),
    dev: String(stat.dev),
  });
  return `v${VERSION}:${crypto.createHash("sha256").update(identity).digest("hex")}`;
};

const unavailableFingerprint = (resolved, reason) => `v${VERSION}:${crypto.createHash("sha256")
  .update(JSON.stringify({ path: resolved, reason }))
  .digest("hex")}`;

async function fileState(resolved) {
  const stat = await fs.promises.lstat(resolved, { bigint: true });
  if (stat.isSymbolicLink()) {
    const error = new Error("symbolic links are not accepted");
    error.reason = "symlink";
    throw error;
  }
  if (!stat.isFile()) {
    const error = new Error("media path is not a regular file");
    error.reason = "not-file";
    throw error;
  }
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    const error = new Error("media file is too large to represent safely");
    error.reason = "size";
    throw error;
  }
  const size = Number(stat.size);
  return { size, fingerprint: fingerprintFor(resolved, stat) };
}

function resultFor(resolved, state, overrides = {}) {
  return {
    version: VERSION,
    fingerprint: state?.fingerprint ?? unavailableFingerprint(resolved, overrides.reason ?? "unavailable"),
    size: state?.size ?? 0,
    valid: false,
    duration: 0,
    profile: null,
    sha256: null,
    reason: null,
    cacheHit: false,
    ...overrides,
  };
}

function parseBox(buffer, offset, end = buffer.length) {
  if (offset + 8 > end) return null;
  const size32 = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);
  let headerSize = 8;
  let size;
  if (size32 === 1) {
    if (offset + 16 > end) return null;
    const extended = buffer.readBigUInt64BE(offset + 8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(extended);
    headerSize = 16;
  } else if (size32 === 0) {
    size = end - offset;
  } else {
    size = size32;
  }
  if (!Number.isSafeInteger(size) || size < headerSize || size > end - offset) return null;
  return {
    start: offset,
    end: offset + size,
    size,
    headerSize,
    type,
    bodyStart: offset + headerSize,
  };
}

function childrenOf(buffer, start = 0, end = buffer.length) {
  const children = [];
  let offset = start;
  for (let count = 0; offset + 8 <= end && count < MAX_NESTED_BOXES; count += 1) {
    const box = parseBox(buffer, offset, end);
    if (!box) break;
    children.push(box);
    offset = box.end;
  }
  if (offset !== end) throw Object.assign(new Error("invalid or excessive nested MP4 boxes"), { code: "box-structure" });
  return children;
}

function fixedPointDimension(raw) {
  const value = raw / 65536;
  if (!Number.isFinite(value) || value <= 0 || value > 32768) return null;
  return Math.round(value);
}

function readTkhdProfile(body) {
  if (body.length < 4) return null;
  const version = body[0];
  if (version > 1) return null;
  const widthOffset = version === 1 ? 84 : 76;
  if (body.length < widthOffset + 8) return null;
  const width = fixedPointDimension(body.readUInt32BE(widthOffset));
  const height = fixedPointDimension(body.readUInt32BE(widthOffset + 4));
  return width && height ? { width, height } : null;
}

function readHdlrType(body) {
  return body.length >= 12 ? body.toString("ascii", 8, 12) : null;
}

function readStsdProfile(body) {
  if (body.length < 8) return null;
  const entryCount = body.readUInt32BE(4);
  if (entryCount === 0 || entryCount > MAX_NESTED_BOXES) return null;
  let first = null;
  let offset = 8;
  for (let count = 0; count < entryCount && count < MAX_NESTED_BOXES; count += 1) {
    const entry = parseBox(body, offset);
    if (!entry) return null;
    const codec = body.toString("ascii", entry.start + 4, entry.start + 8).toLowerCase();
    if (!isPrintableFourcc(codec)) return null;
    const entryBody = body.subarray(entry.bodyStart, entry.end);
    let dimensions = null;
    if (entryBody.length >= 28) {
      const width = entryBody.readUInt16BE(24);
      const height = entryBody.readUInt16BE(26);
      if (width > 0 && height > 0) dimensions = { width, height };
    }
    const current = { codec, dimensions };
    if (!first) first = current;
    else if (first.codec !== current.codec || !sameDimensions(first.dimensions, current.dimensions)) return null;
    offset = entry.end;
  }
  return offset === body.length ? first : null;
}

function sameDimensions(left, right) {
  return Boolean(left && right && left.width === right.width && left.height === right.height);
}

function readDuration(body) {
  if (body.length < 20) return null;
  const version = body[0];
  if (version === 0) {
    if (body.length < 20) return null;
    const scale = body.readUInt32BE(12);
    const ticks = body.readUInt32BE(16);
    const duration = scale > 0 ? ticks / scale : 0;
    return Number.isFinite(duration) && duration > 0 && duration < 86400 ? duration : null;
  }
  if (version === 1 && body.length >= 32) {
    const scale = body.readUInt32BE(20);
    const ticks = body.readBigUInt64BE(24);
    if (scale === 0 || ticks === 0n || ticks > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const duration = Number(ticks) / scale;
    return Number.isFinite(duration) && duration > 0 && duration < 86400 ? duration : null;
  }
  return null;
}

function readVideoTrack(trakBody) {
  const trakChildren = childrenOf(trakBody);
  const tkhd = trakChildren.find((box) => box.type === "tkhd");
  const mdia = trakChildren.find((box) => box.type === "mdia");
  if (!tkhd || !mdia) return null;
  const mdiaBody = mdiaBodyFor(trakBody, mdia);
  const mdiaChildren = childrenOf(mdiaBody);
  const hdlr = mdiaChildren.find((box) => box.type === "hdlr");
  const minf = mdiaChildren.find((box) => box.type === "minf");
  if (!hdlr || !minf || readHdlrType(mdiaBody.subarray(hdlr.bodyStart, hdlr.end)) !== "vide") {
    return null;
  }
  const minfBody = mdiaBody.subarray(minf.bodyStart, minf.end);
  const stbl = childrenOf(minfBody).find((box) => box.type === "stbl");
  if (!stbl) return null;
  const stblBody = minfBody.subarray(stbl.bodyStart, stbl.end);
  const stsd = childrenOf(stblBody).find((box) => box.type === "stsd");
  if (!stsd) return null;
  const codecProfile = readStsdProfile(stblBody.subarray(stsd.bodyStart, stsd.end));
  if (!codecProfile) return null;
  const tkhdProfile = readTkhdProfile(trakBody.subarray(tkhd.bodyStart, tkhd.end));
  const dimensions = tkhdProfile ?? codecProfile.dimensions;
  if (!dimensions) return null;
  return { width: dimensions.width, height: dimensions.height, codec: codecProfile.codec };
}

function isVideoTrack(trakBody) {
  const trakChildren = childrenOf(trakBody);
  const mdia = trakChildren.find((box) => box.type === "mdia");
  if (!mdia) return false;
  const mdiaBody = mdiaBodyFor(trakBody, mdia);
  const hdlr = childrenOf(mdiaBody).find((box) => box.type === "hdlr");
  return Boolean(hdlr && readHdlrType(mdiaBody.subarray(hdlr.bodyStart, hdlr.end)) === "vide");
}

function mdiaBodyFor(trakBody, mdia) {
  return trakBody.subarray(mdia.bodyStart, mdia.end);
}

async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await handle.read(buffer, offset, length - offset, position + offset);
    if (read.bytesRead === 0) return null;
    offset += read.bytesRead;
  }
  return buffer;
}

async function isUidTagSuffix(handle, offset, size) {
  // Native tagFile appends an opaque UID payload after the marker. Accept it
  // only at a complete MP4 box boundary, with a small independent size bound.
  if (size - offset < UID_TAG.length || size - offset > MAX_UID_SUFFIX_BYTES) return false;
  const suffix = await readAt(handle, UID_TAG.length, offset);
  return Boolean(suffix && suffix.equals(UID_TAG));
}

async function inspectStructure(resolved, size) {
  const handle = await fs.promises.open(resolved, "r");
  try {
    let offset = 0;
    let mediaBytes = size;
    let metadataBytes = 0;
    let ftyp = false;
    let duration = null;
    const videoProfiles = [];
    let mdat = false;
    for (let count = 0; offset + 8 <= size && count < MAX_TOP_LEVEL_BOXES; count += 1) {
      if (await isUidTagSuffix(handle, offset, size)) {
        mediaBytes = offset;
        offset = size;
        break;
      }
      const header = await readAt(handle, Math.min(16, size - offset), offset);
      if (!header) return { valid: false, reason: "truncated" };
      const size32 = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      let headerSize = 8;
      let boxSize = size32;
      if (size32 === 1) {
        if (offset + 16 > size) break;
        const extended = header.readBigUInt64BE(8);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return { valid: false, reason: "truncated" };
        boxSize = Number(extended);
        headerSize = 16;
      } else if (size32 === 0) {
        boxSize = size - offset;
      }
      if (!Number.isSafeInteger(boxSize) || boxSize < headerSize || boxSize > size - offset) {
        return { valid: false, reason: "truncated" };
      }
      if (offset === 0 && type !== "ftyp") return { valid: false, reason: "ftyp" };
      if (type === "ftyp") {
        if (boxSize < 16 || boxSize - headerSize > MAX_FTYP_BYTES) return { valid: false, reason: "ftyp" };
        const body = await readAt(handle, boxSize - headerSize, offset + headerSize);
        if (!body || body.length < 8 || !isPrintableFourcc(body.toString("ascii", 0, 4))) {
          return { valid: false, reason: "ftyp" };
        }
        metadataBytes += body.length;
        ftyp = true;
      } else if (type === "moov") {
        if (boxSize - headerSize > MAX_METADATA_BYTES || metadataBytes + boxSize - headerSize > MAX_METADATA_BYTES) {
          return { valid: false, reason: "metadata-limit" };
        }
        const body = await readAt(handle, boxSize - headerSize, offset + headerSize);
        if (!body) return { valid: false, reason: "truncated" };
        metadataBytes += body.length;
        for (const child of childrenOf(body)) {
          if (child.type === "mvhd" && duration === null) {
            duration = readDuration(body.subarray(child.bodyStart, child.end));
          } else if (child.type === "trak" && isVideoTrack(body.subarray(child.bodyStart, child.end))) {
            const profile = readVideoTrack(body.subarray(child.bodyStart, child.end));
            if (!profile) return { valid: false, reason: "video-profile" };
            videoProfiles.push(profile);
          }
        }
      } else if (type === "mdat" && boxSize > headerSize) {
        mdat = true;
      }
      offset += boxSize;
    }
    if (offset < size && !(await isUidTagSuffix(handle, offset, size))) {
      return { valid: false, reason: "trailing-box" };
    }
    if (!ftyp) return { valid: false, reason: "ftyp" };
    if (!duration) return { valid: false, reason: "duration" };
    if (videoProfiles.length === 0) return { valid: false, reason: "video-track" };
    if (videoProfiles.length > 1) return { valid: false, reason: "video-track-multiple" };
    if (!mdat) return { valid: false, reason: "mdat" };
    return { valid: true, duration, profile: videoProfiles[0], mediaBytes };
  } finally {
    await handle.close();
  }
}

function sameProfile(left, right) {
  return Boolean(left && right && left.width === right.width && left.height === right.height && left.codec === right.codec);
}

function reusable(previous, state, inspection) {
  return Boolean(previous && previous.version === VERSION && previous.fingerprint === state.fingerprint
    && previous.valid === true && typeof previous.sha256 === "string" && SHA256_RE.test(previous.sha256)
    && sameProfile(previous.profile, inspection.profile));
}

function consumeBudget(budget, size) {
  const target = budget && typeof budget === "object" ? budget : { remainingBytes: DEFAULT_HASH_BUDGET };
  const current = target.remainingBytes ?? DEFAULT_HASH_BUDGET;
  if (typeof current === "bigint") {
    const needed = BigInt(size);
    if (current < needed) return false;
    target.remainingBytes = current - needed;
    return true;
  }
  if (!Number.isFinite(current) || current < size) return false;
  target.remainingBytes = current - size;
  return true;
}

async function sha256File(resolved, mediaBytes) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(resolved, { highWaterMark: 1024 * 1024, end: mediaBytes - 1 });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export async function inspectVideo(filePath, { previous = null, budget = { remainingBytes: DEFAULT_HASH_BUDGET } } = {}) {
  const resolved = path.resolve(String(filePath));
  let state;
  try {
    state = await fileState(resolved);
  } catch (error) {
    return resultFor(resolved, null, { reason: error.reason ?? error.code ?? "unavailable" });
  }

  let inspection;
  try {
    inspection = await inspectStructure(resolved, state.size);
  } catch (error) {
    return resultFor(resolved, state, { reason: error.code ?? "read-error" });
  }
  if (!inspection.valid) return resultFor(resolved, state, { reason: inspection.reason });

  const metadata = resultFor(resolved, state, {
    valid: true,
    duration: inspection.duration,
    profile: inspection.profile,
  });

  let current;
  try {
    current = await fileState(resolved);
  } catch {
    return resultFor(resolved, null, { reason: "changed" });
  }
  if (current.fingerprint !== state.fingerprint || current.size !== state.size) {
    return resultFor(resolved, current, { reason: "changed" });
  }
  if (reusable(previous, state, inspection)) {
    return { ...metadata, sha256: previous.sha256, cacheHit: true, reason: previous.reason ?? null };
  }
  if (!consumeBudget(budget, inspection.mediaBytes)) return { ...metadata, reason: "hash-budget" };

  try {
    metadata.sha256 = await sha256File(resolved, inspection.mediaBytes);
  } catch (error) {
    return resultFor(resolved, state, { reason: error.code ?? "read-error" });
  }
  try {
    current = await fileState(resolved);
  } catch {
    return resultFor(resolved, null, { reason: "changed" });
  }
  if (current.fingerprint !== state.fingerprint || current.size !== state.size) {
    return resultFor(resolved, current, { reason: "changed" });
  }
  metadata.reason = null;
  return metadata;
}
