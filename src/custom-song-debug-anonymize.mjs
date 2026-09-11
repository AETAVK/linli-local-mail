import crypto from 'node:crypto';

const FIELDS = new Set(['attributes', 'query.action', 'query.request', 'query.response', 'id', 'name', 'nameKey',
  'videoByTodView', 'tod', 'url', 'view', 'songs', 'data', 'result', 'localCustomSong', 'localEvidenceVersion']);
const ACTIONS = new Set(['checkLocalSongs', 'startSongDownload']);
const FIXED = new Set(['TOD12', 'TOD1730', 'TOD20', 'NI', 'WI']);

export function isSongEvidenceCandidate(line) {
  // Structural hint for bounded/malformed JSON only; prose mentioning these words is not evidence.
  return /"query\.action"\s*:\s*"(?:checkLocalSongs|startSongDownload)"|["\\](?:nameKey|videoByTodView)\\*"\s*:/.test(line);
}

export class SongEvidenceAnonymizer {
  #values = new Map(); #keys = new Map(); #keyGroups = new Map(); #files = new Map(); #fields = new Map(); #groups = new Map();
  #namespace = crypto.randomInt(1000000, 9999999);
  alias(map, raw, prefix) {
    if (!map.has(raw)) map.set(raw, `${prefix}${map.size + 1}`);
    return map.get(raw);
  }
  key(raw) {
    const parts=typeof raw==='string'&&raw.match(/^midi_(\d+)_(\d+)$/);
    return parts ? `midi_${this.alias(this.#keyGroups,parts[1],String(this.#namespace))}_${this.alias(this.#keys,parts[2],'')}` : this.value(raw);
  }
  file(raw) { return this.alias(this.#files, String(raw).toLowerCase(), 'media_') + '.mp4'; }
  value(raw) {
    if (typeof raw !== 'string') return raw;
    if (!raw || /^\s+$/.test(raw)) return raw;
    if (/^midi_\d+_\d+$/.test(raw)) return this.key(raw);
    if (/^\d+$/.test(raw)) return this.alias(this.#values, raw, `${this.#namespace}`);
    return this.alias(this.#values, raw, 'value_');
  }
  #url(raw, losses) {
    try {
      const url = new URL(raw);
      const official = url.protocol === 'https:' && url.hostname === 'static-cnbeta01.olivia.miyoushe.com';
      const match = url.pathname.match(/^\/midiPerf\/([^/]+)\/([^/]+)\/([^/]+)$/i);
      if (official && match) return `https://static-cnbeta01.olivia.miyoushe.com/midiPerf/1/${this.alias(this.#groups, match[1] + '/' + match[2], '')}/${this.file(decodeURIComponent(match[3]))}`;
      if (raw.includes('/custom-song-media/')) return 'http://127.0.0.1/custom-song-media/redacted.mp4';
    } catch { /* arbitrary malformed URLs are not retained */ }
    losses.add('unrecognized-url-replaced');
    return 'https://redacted.invalid/media.mp4';
  }
  text(input, depth = 0) {
    const losses = new Set();
    if (depth > 4 || input.length > 1024 * 1024) return { text: 'null', losses: ['anonymization-limit'] };
    let output = '', i = 0, field = '', expectingKey = false;
    const frames = [];
    const stringValue = (value, key) => {
      if (key === 'query.action') {
        if (ACTIONS.has(value)) return value;
        losses.add('unknown-action-aliased'); return this.value(value);
      }
      if (key === 'nameKey') return this.key(value);
      if ((key === 'tod' || key === 'view') && FIXED.has(value)) return value;
      if (/^https?:/i.test(value) || value.includes('/custom-song-media/')) return this.#url(value, losses);
      if (key === 'query.request' || key === 'query.response') {
        const inner = this.text(value, depth + 1);
        for (const loss of inner.losses) losses.add(loss);
        return inner.text;
      }
      return this.value(value);
    };
    while (i < input.length) {
      const ch = input[i];
      if (/\s/.test(ch)) { output += ch; i++; continue; }
      if (ch === '"') {
        const start = i++;
        let closed = false;
        while (i < input.length) {
          const c = input[i++];
          if (c === '\\') { if (i < input.length) i++; continue; }
          if (c === '"') { closed = true; break; }
        }
        const token = input.slice(start, i);
        let value, valid = false;
        if (closed) try { value = JSON.parse(token); valid = true; } catch { /* fixed malformed replacement below */ }
        const key = frames.at(-1)?.type === '{' && expectingKey;
        const payload = depth > 0 || frames.at(-1)?.payload;
        if (valid) {
          if (key) {
            field = value;
            if (!FIELDS.has(value)) losses.add(payload ? 'unknown-field-aliased' : 'outer-field-aliased');
            output += JSON.stringify(FIELDS.has(value) ? value : this.alias(this.#fields, value, 'field_'));
            expectingKey = false;
          } else output += JSON.stringify(stringValue(value, field));
          if (token !== JSON.stringify(value)) losses.add('escape-spelling-normalized');
        } else {
          losses.add('malformed-string-replaced');
          // Preserve fixed escape/control categories, never their raw characters or excerpts.
          let body = 'redacted';
          if (/\\u(?:[^0-9a-f]|[0-9a-f]{0,3}(?:"|$))/i.test(token)) body += '\\uZZZZ';
          else if (/\\[^"\\/bfnrtu]/.test(token)) body += '\\q';
          if (/[\x00-\x1f]/.test(token)) body += '\n';
          output += '"' + body + (closed ? '"' : token.endsWith('\\') ? '\\' : '');
        }
        continue;
      }
      if ('{}[]:,'.includes(ch)) {
        output += ch; i++;
        if (ch === '{' || ch === '[') { frames.push({ type: ch, payload: Boolean(frames.at(-1)?.payload || field === 'query.request' || field === 'query.response') }); expectingKey = ch === '{'; field = ''; }
        else if (ch === '}' || ch === ']') { frames.pop(); expectingKey = false; field = ''; }
        else if (ch === ',') { expectingKey = frames.at(-1)?.type === '{'; field = ''; }
        continue;
      }
      const start = i;
      while (i < input.length && !/[\s{}\[\]:,"]/.test(input[i])) i++;
      const token = input.slice(start, i);
      if (['true', 'false', 'null'].includes(token)) output += token;
      else if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
        const number = Number(token);
        if (Number.isSafeInteger(number) && number >= 0) output += this.value(String(number));
        else {
          losses.add(depth > 0 || frames.at(-1)?.payload ? 'numeric-value-generalized' : 'outer-number-generalized');
          output += token.startsWith('-') ? '-1' : '1.5';
        }
      }
      else { losses.add('bare-token-replaced'); output += /^'.*'$/.test(token) ? "'redacted'" : 'redacted'; }
    }
    return { text: output, losses: [...losses].sort() };
  }
  line(raw) {
    const marker = raw.indexOf('[OTEL Logger]');
    const body = marker >= 0 ? raw.slice(marker + 13).trimStart() : raw;
    const result = this.text(body);
    if (marker < 0) result.losses.push('missing-marker-context');
    return { text: (marker >= 0 ? '[OTEL Logger] ' : '') + result.text, losses: [...new Set(result.losses)].sort() };
  }
}
