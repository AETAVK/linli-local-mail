import { createHmac } from 'node:crypto';

export const ACR_HOST = 'identify-cn-north-1.acrcloud.cn';

const IDENTIFY_PATH = '/v1/identify';
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
const safeErrors = new WeakSet();

function providerError(code, message, providerCode) {
  const error = new Error(message);
  error.code = code;
  error.phase = 'recognition-request';
  if (Number.isFinite(providerCode)) error.providerCode = providerCode;
  safeErrors.add(error);
  return error;
}

function bytesOf(audio) {
  if (audio instanceof ArrayBuffer) return new Uint8Array(audio);
  if (ArrayBuffer.isView(audio)) return new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  return null;
}

function scoreOf(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.max(0, Math.min(1, number > 1 && number <= 100 ? number / 100 : number));
}

function safeCandidateName(value) {
  if (typeof value !== 'string') return '';
  let name;
  try { name = value.normalize('NFKC'); } catch { name = value; }
  return name.replace(/[\p{Cc}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 240);
}

function providerIdOf(candidate) {
  for (const key of ['result_id', 'song_id', 'acrid', 'id']) {
    const value = candidate?.[key];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      const id = String(value).normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 128).trim();
      if (id) return id;
    }
  }
  return undefined;
}

function statusCodeOf(payload) {
  const value = payload?.status?.code ?? payload?.code;
  const code = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(code) ? code : null;
}

function classifyProviderCode(code, httpStatus) {
  if (code === 3003) return 'SONG_RECOGNITION_QUOTA';
  if (httpStatus === 401 || httpStatus === 403 || [3001, 3014].includes(code)) return 'SONG_RECOGNITION_AUTH';
  if (httpStatus === 429 || code === 3015) return 'SONG_RECOGNITION_RATE_LIMIT';
  if ([3002, 3006].includes(code)) return 'SONG_RECOGNITION_INPUT';
  return 'SONG_RECOGNITION_SERVICE';
}

function contentLengthOf(response) {
  const value = response?.headers?.get?.('content-length') ?? response?.headers?.['content-length'];
  const length = Number(value);
  return Number.isFinite(length) ? length : null;
}

// Fetch implementations and synthetic streams may not reject pending IO on abort.
// Race every asynchronous stage and detach its listener as soon as it settles.
async function withAbort(operation, signal) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation(), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function boundedResponseText(response, signal) {
  const declared = contentLengthOf(response);
  if (declared !== null && declared > MAX_RESPONSE_BYTES) throw providerError('SONG_RECOGNITION_SERVICE', 'Recognition response too large');

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let complete = false;
    try {
      while (true) {
        const part = await withAbort(() => reader.read(), signal);
        if (part.done) { complete = true; break; }
        const chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          throw providerError('SONG_RECOGNITION_SERVICE', 'Recognition response too large');
        }
        chunks.push(chunk);
      }
    } finally {
      // Cancellation itself may stall; never await transport cleanup.
      if (!complete) {
        try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ }
      }
      reader.releaseLock?.();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  }

  if (typeof response?.arrayBuffer === 'function') {
    const bytes = new Uint8Array(await withAbort(() => response.arrayBuffer(), signal));
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw providerError('SONG_RECOGNITION_SERVICE', 'Recognition response too large');
    return new TextDecoder().decode(bytes);
  }
  if (typeof response?.text === 'function') {
    const text = await withAbort(() => response.text(), signal);
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw providerError('SONG_RECOGNITION_SERVICE', 'Recognition response too large');
    return text;
  }
  throw providerError('SONG_RECOGNITION_SERVICE', 'Recognition response unavailable');
}

export async function recognizeAcr({
  audio,
  mimeType = 'audio/aac',
  accessKey,
  accessSecret,
  signal,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
} = {}) {
  const bytes = bytesOf(audio);
  if (!bytes) throw providerError('SONG_RECOGNITION_INPUT', 'Audio bytes are required');
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw providerError('SONG_RECOGNITION_INPUT', 'Audio sample is too large');
  if (typeof accessKey !== 'string' || !accessKey || typeof accessSecret !== 'string' || !accessSecret) {
    throw providerError('SONG_RECOGNITION_AUTH', 'Recognition credentials are unavailable');
  }
  if (typeof fetchImpl !== 'function') throw providerError('SONG_RECOGNITION_SERVICE', 'Recognition transport is unavailable');
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) throw providerError('SONG_RECOGNITION_INPUT', 'Recognition timeout is invalid');
  if (signal?.aborted) throw providerError('SONG_RECOGNITION_ABORTED', 'Recognition was aborted');

  const timestamp = Math.floor(Date.now() / 1000);
  const signatureText = `POST\n${IDENTIFY_PATH}\n${accessKey}\naudio\n1\n${timestamp}`;
  const signature = createHmac('sha1', accessSecret).update(signatureText).digest('base64');
  const form = new FormData();
  form.append('access_key', accessKey);
  form.append('data_type', 'audio');
  form.append('signature_version', '1');
  form.append('signature', signature);
  form.append('timestamp', String(timestamp));
  form.append('sample_bytes', String(bytes.byteLength));
  form.append('sample', new Blob([bytes], { type: typeof mimeType === 'string' && mimeType ? mimeType : 'audio/aac' }), 'anonymous');

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  let response;
  try {
    response = await withAbort(() => fetchImpl(`https://${ACR_HOST}${IDENTIFY_PATH}`, {
      method: 'POST', body: form, redirect: 'error', signal: controller.signal,
    }), controller.signal);
    const payload = JSON.parse(await boundedResponseText(response, controller.signal));
    controller.signal.throwIfAborted();
    const providerCode = statusCodeOf(payload);
    const httpStatus = Number(response?.status);
    if (providerCode === 0 && (httpStatus < 400 || !Number.isFinite(httpStatus))) {
      const humming = Array.isArray(payload?.metadata?.humming) ? payload.metadata.humming : [];
      const candidates = humming.flatMap(candidate => {
        const name = safeCandidateName(candidate?.title);
        const score = scoreOf(candidate?.score);
        if (!name || score === null) return [];
        const result = { name, score };
        const providerId = providerIdOf(candidate);
        if (providerId !== undefined) result.providerId = providerId;
        return [result];
      });
      if (!candidates.length && Array.isArray(payload?.metadata?.music) && payload.metadata.music.length) {
        throw providerError('SONG_RECOGNITION_WRONG_ENGINE', 'Recognition returned music metadata without humming matches', providerCode);
      }
      return { status: candidates.length ? 'matched' : 'no-match', candidates };
    }
    if (providerCode === 1001 && httpStatus < 400) return { status: 'no-match', candidates: [] };
    throw providerError(classifyProviderCode(providerCode, Number.isFinite(httpStatus) ? httpStatus : null), 'Recognition service rejected the request', providerCode ?? httpStatus);
  } catch (cause) {
    if (timedOut) throw providerError('SONG_RECOGNITION_TIMEOUT', 'Recognition request timed out');
    if (signal?.aborted || controller.signal.aborted) throw providerError('SONG_RECOGNITION_ABORTED', 'Recognition was aborted');
    if (safeErrors.has(cause)) throw cause;
    throw providerError('SONG_RECOGNITION_SERVICE', 'Recognition request or response failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
