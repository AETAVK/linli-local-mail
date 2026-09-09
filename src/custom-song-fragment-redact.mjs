// Optional diagnostic fragments retain song structure, NOT original bytes or anonymity.
// Unsupported credential-bearing grammar is omitted, never returned as raw fallback.
export const FRAGMENT_POLICY = 'targeted-credentials-v1';
export const REDACTED = '[REDACTED]';
const defaults = Object.freeze({ bytes: 32768, depth: 12, nodes: 4096, stringBytes: 16384, textBudget: 131072 });
const normalize = key => String(key).normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
export function credentialKey(key) {
  const name = normalize(key);
  return /(?:token|authorization|cookie|password|passwd|passphrase|apikey|secret|credential|signature|privatekey|accesskey)(?:s|id|value|header)?$/.test(name) ||
    /^(?:pwd|auth|authkey|authcode|authorizationcode|sig|session|sessionid|sessionkey|jwt|xcsrf|xxsrf|ossaccesskeyid|awsaccesskeyid|口令|密码|密钥|令牌)$/.test(name) ||
    /^(?:xamz|xoss|xgoog)(?:securitytoken|credential|signature|algorithm|signedheaders)$/.test(name);
}
export function redactSongFragment(line, limits = {}) {
  const budget = { ...defaults, ...limits };
  let nodes = 0, strings = 0, redactions = 0;
  const fail = reason => { throw new Error(reason); };
  const mask = () => { redactions++; return REDACTED; };
  function decoded(value) {
    try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { fail('invalid-encoding'); }
  }
  function url(value) {
    // URI parsing can silently retain malformed escapes. Reject those before parsing.
    if (/%(?![\da-f]{2})/i.test(value)) fail('invalid-encoding');
    let parsed; try { parsed = new URL(value); } catch { fail('unsupported-url'); }
    if (!/^https?:$/.test(parsed.protocol)) fail('unsupported-url');
    if (parsed.username || parsed.password) { parsed.username = ''; parsed.password = ''; redactions++; }
    if (parsed.hash) { parsed.hash = ''; redactions++; }
    const pairs = [...parsed.searchParams];
    if (pairs.length > 128) fail('budget-exceeded');
    parsed.search = '';
    for (const [key, val] of pairs) {
      if (key.length > 256) fail('budget-exceeded');
      // Unknown query parameters may be signed credentials. Only known song selectors survive.
      parsed.searchParams.append(key, /^(?:id|nameKey|tod|view)$/i.test(key) && !credentialKey(key) ? text(val, 1) : mask());
    }
    parsed.pathname = mediaPath(parsed.pathname);
    return parsed.href;
  }
  function mediaPath(value) {
    // Decode bounded layers before capability matching, including encoded slash/case.
    for (let i = 0; i < 3 && /%[\da-f]{2}/i.test(value); i++) value = decoded(value);
    if (/%[\da-f]{2}/i.test(value)) fail('unsupported-encoded-text');
    return value.replace(/([/\\]custom-song-media[/\\])[^/\\\s?#]+/gi, (_, prefix) => prefix + mask());
  }
  function text(value, depth) {
    strings += Buffer.byteLength(value);
    if (Buffer.byteLength(value) > budget.stringBytes || strings > budget.textBudget || depth > budget.depth) fail('budget-exceeded');
    const trimmed = value.trim();
    // JSON string payloads remain strings, but their decoded values/keys are processed recursively.
    if (/^[\[{\"]/.test(trimmed) && trimmed !== REDACTED) {
      let inner; try { inner = JSON.parse(trimmed); } catch { fail('malformed-json-string'); }
      return JSON.stringify(walk(inner, depth + 1));
    }
    if (/^(?:Bearer|Basic)\s+\S+/i.test(trimmed) || /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(trimmed)) return mask();
    if (/^https?:\/\/\S+$/i.test(trimmed)) return url(trimmed);
    if (/^[^\s=&]+=[^\r\n]*(?:&[^\s=&]+=.*)*$/.test(trimmed)) {
      const parts = trimmed.split('&'); if (parts.length > 128) fail('budget-exceeded');
      return parts.map(part => {
        const i = part.indexOf('='), key = decoded(part.slice(0, i)), val = decoded(part.slice(i + 1));
        if (key.length > 256) fail('budget-exceeded');
        return encodeURIComponent(key) + '=' + encodeURIComponent(credentialKey(key) ? mask() : text(val, depth + 1));
      }).join('&');
    }
    // Full header lines can be transformed without guessing where a credential ends.
    if (/^[\w-]+\s*:/.test(trimmed)) {
      const lines = trimmed.split(/\r?\n/);
      if (lines.every(item => /^[\w-]+\s*:/.test(item))) return lines.map(item => {
        const i = item.indexOf(':'), key = item.slice(0, i);
        return key + ': ' + (credentialKey(key) ? mask() : text(item.slice(i + 1).trim(), depth + 1));
      }).join('\n');
    }
    let result = mediaPath(value);
    result = result.replace(/https?:\/\/[^\s<>"']+/gi, match => url(match));
    // Do not attempt partial substitutions in an ambiguous multi-line/malformed grammar.
    if (/(?:access[ _-]*token|refresh[ _-]*token|\btoken\b|authorization|cookie|password|passwd|\bpwd\b|api[ _-]*key|secret|credential|signature|\bsig\b|bearer\s|basic\s)\s*(?:[:=]|\s)/i.test(result)) fail('unsupported-sensitive-text');
    if (/%(?:25)*(?:5f|74|54|61|41)/i.test(result) && /[=&]/.test(result)) fail('unsupported-encoded-text');
    return result;
  }
  function walk(value, depth) {
    if (++nodes > budget.nodes || depth > budget.depth) fail('budget-exceeded');
    if (typeof value === 'string') return text(value, depth);
    if (Array.isArray(value)) {
      if (value.length === 2 && typeof value[0] === 'string' && credentialKey(value[0])) return [value[0], mask()];
      return value.map(item => walk(item, depth + 1));
    }
    if (!value || typeof value !== 'object') return value;
    const entries = Object.entries(value);
    const headerPair = entries.some(([key, val]) => /^(?:name|key|headername)$/i.test(normalize(key)) && typeof val === 'string' && credentialKey(val));
    return Object.fromEntries(entries.map(([key, val]) => {
      if (key.length > 256) fail('budget-exceeded');
      return [key, credentialKey(key) || headerPair && /^(?:value|values|headervalue)$/.test(normalize(key)) ? mask() : walk(val, depth + 1)];
    }));
  }
  try {
    if (typeof line !== 'string' || Buffer.byteLength(line) > budget.bytes) fail('budget-exceeded');
    const marker = '[OTEL Logger]', position = line.indexOf(marker);
    if (position < 0) fail('missing-marker');
    let outer; try { outer = JSON.parse(line.slice(position + marker.length).trim()); } catch { fail('malformed-outer-json'); }
    if (!outer || Array.isArray(outer) || typeof outer !== 'object') fail('unsupported-outer');
    const output = marker + ' ' + JSON.stringify(walk(outer, 0));
    if (Buffer.byteLength(output) > budget.bytes) fail('budget-exceeded');
    return { ok: true, text: output, redactions, policy: FRAGMENT_POLICY, contentKind: 'credential-redacted-fragment' };
  } catch (error) {
    const reason = ['budget-exceeded','invalid-encoding','unsupported-url','malformed-json-string','unsupported-sensitive-text','unsupported-encoded-text','missing-marker','malformed-outer-json','unsupported-outer'].includes(error.message) ? error.message : 'unsafe-fragment';
    return { ok: false, reason, policy: FRAGMENT_POLICY };
  }
}
