// Observational only: never used to parse, repair, or select song records.
// No token contains an input value or an unrecognized field name.
const FIELD_NAMES = new Set(['id', 'name', 'nameKey', 'videoByTodView', 'tod', 'url', 'view',
  'data', 'result', 'songs', 'localCustomSong', 'localEvidenceVersion']);
const MAX_CHARACTERS = 1024 * 1024;
const MAX_DEPTH = 128;
const PREVIEW_TOKENS = 12;

export function evidenceType(value, present = true) {
  if (!present) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  return ['string', 'object', 'number', 'boolean'].includes(type) ? type : 'other';
}

// Shallow shape of an already parsed outer request, not a raw-text reconstruction.
// Fixed field probes avoid enumerating arbitrary keys or walking the whole object.
export function inspectFieldShape(value) {
  const shallow = item => {
    const type = evidenceType(item);
    if (type === 'array') return { type, length: item.length };
    if (type !== 'object') return { type };
    const fields = {};
    for (const field of FIELD_NAMES) if (Object.hasOwn(item, field)) fields[field] = evidenceType(item[field]);
    return { type, fields };
  };
  return { basis: 'parsed-outer-request', ...shallow(value),
    ...(Array.isArray(value) ? { items: value.slice(0, 2).map(shallow), omittedItems: Math.max(0, value.length - 2) } : {}) };
}

export function jsonErrorEvidence(error, characters) {
  if (!error) return { category: 'none', position: null, positionUnits: 'utf16-code-units' };
  // Match only engine-owned prefixes/suffixes, and export only fixed labels/numbers.
  // Never persist the message, stack, unexpected token, or quoted input excerpt.
  const message = typeof error.message === 'string' ? error.message : '';
  let category = 'unknown';
  if (error instanceof SyntaxError) {
    if (/^Unexpected end of JSON input$/.test(message)) category = 'unexpected-end';
    else if (/^Unterminated string in JSON/.test(message)) category = 'unterminated-string';
    else if (/^Bad Unicode escape in JSON/.test(message)) category = 'invalid-unicode-escape';
    else if (/^Bad escaped character in JSON/.test(message)) category = 'invalid-escape';
    else if (/^Bad control character in string literal in JSON/.test(message)) category = 'control-character';
    else if (/^Unexpected non-whitespace character after JSON/.test(message)) category = 'trailing-content';
    else if (/^Expected (?:property name|double-quoted property name)/.test(message)) category = 'property-syntax';
    else if (/^Expected (?:','|':')/.test(message)) category = 'separator-syntax';
    else category = 'syntax-other';
  }
  const suffix = message.slice(-100).match(/ (?:in|after) JSON at position (\d+)(?: \(line \d+ column \d+\))?$/);
  const numeric = suffix && category !== 'unknown' ? Number(suffix[1]) : NaN;
  return { category, position: Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= characters ? numeric : null,
    positionUnits: 'utf16-code-units' };
}

// Bounded peek for admission grouping, not a claim about the complete JSON shape.
export function leadingStructureType(text) {
  const first = text.slice(0, 128).trimStart()[0];
  if (first === '{') return 'object';
  if (first === '[') return 'array';
  if (first === '"') return 'string';
  if (first === '-' || (first >= '0' && first <= '9')) return 'number';
  if (first === 't' || first === 'f') return 'boolean';
  if (first === 'n') return 'null';
  return 'unknown';
}

export function inspectRequestStructure(text) {
  const characters = text.length;
  const limit = Math.min(characters, MAX_CHARACTERS);
  const headTokens = [], tailTokens = [], frames = [];
  let index = 0, tokenCount = 0, rootType = 'unknown', rootStarted = false, rootDone = false;
  let openString = false, danglingEscape = false, invalidEscape = false, invalidUnicodeEscape = false;
  let controlCharacter = false, bareToken = false, delimiterMismatch = false, trailingContent = false;
  let maxDepth = 0, stopped = characters > limit ? 'character-limit' : null;
  const emit = token => {
    tokenCount++;
    if (headTokens.length < PREVIEW_TOKENS) headTokens.push(token);
    else { tailTokens.push(token); if (tailTokens.length > PREVIEW_TOKENS) tailTokens.shift(); }
  };
  const beginValue = type => {
    if (!rootStarted) { rootStarted = true; rootType = type; }
    else if (rootDone && !frames.length) trailingContent = true;
    const parent = frames.at(-1);
    if (parent) parent.expect = 'comma-or-end';
  };
  while (index < limit) {
    const c = text[index];
    if (/\s/.test(c)) { index++; continue; }
    if (rootDone && !frames.length) trailingContent = true;
    if (c === '"') {
      const start = index++;
      const isKey = frames.at(-1)?.type === 'object' && frames.at(-1).expect === 'key';
      let closed = false, valid = true;
      while (index < limit) {
        const ch = text[index++];
        if (ch === '"') { closed = true; break; }
        if (ch.charCodeAt(0) < 32) { controlCharacter = true; valid = false; }
        if (ch !== '\\') continue;
        if (index === limit) { danglingEscape = true; break; }
        const escape = text[index++];
        if (escape === 'u') {
          for (let digit = 0; digit < 4; digit++) {
            if (index === limit) { danglingEscape = true; valid = false; break; }
            if (!/[0-9a-f]/i.test(text[index])) { invalidUnicodeEscape = true; valid = false; break; }
            index++;
          }
        } else if (!'"\\/bfnrt'.includes(escape)) { invalidEscape = true; valid = false; }
      }
      openString = !closed;
      let token = isKey ? 'KEY' : 'STRING';
      if (!closed) token += '_OPEN';
      // Only a complete short object-key token is eligible for field-name recognition.
      if (isKey && closed && valid && index - start <= 128) {
        try { const key = JSON.parse(text.slice(start, index)); if (FIELD_NAMES.has(key)) token = `KEY:${key}`; } catch { /* generic KEY */ }
      }
      emit(token);
      if (isKey) frames.at(-1).expect = 'colon';
      else { beginValue('string'); if (!frames.length && closed) rootDone = true; }
      continue;
    }
    if (c === '{' || c === '[') {
      beginValue(c === '{' ? 'object' : 'array'); emit(c); index++;
      if (frames.length >= MAX_DEPTH) { stopped = 'depth-limit'; break; }
      frames.push({ type: c === '{' ? 'object' : 'array', expect: c === '{' ? 'key' : 'value' });
      maxDepth = Math.max(maxDepth, frames.length);
      continue;
    }
    if (c === '}' || c === ']') {
      emit(c); index++;
      const frame = frames.pop();
      if (!frame || frame.type !== (c === '}' ? 'object' : 'array')) delimiterMismatch = true;
      if (!frames.length) rootDone = true;
      continue;
    }
    if (c === ':' || c === ',') {
      emit(c); index++;
      const frame = frames.at(-1);
      if (frame) frame.expect = c === ':' ? 'value' : frame.type === 'object' ? 'key' : 'value';
      continue;
    }
    const start = index;
    while (index < limit && !/[\s{}\[\]:,"]/.test(text[index])) index++;
    const atom = text.slice(start, index);
    let type = 'unknown', token = 'ATOM';
    if (atom === 'null') { type = 'null'; token = 'NULL'; }
    else if (atom === 'true' || atom === 'false') { type = 'boolean'; token = 'BOOLEAN'; }
    else if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(atom)) { type = 'number'; token = 'NUMBER'; }
    else bareToken = true;
    beginValue(type); emit(token); if (!frames.length) rootDone = true;
  }
  const complete = index === characters && stopped === null;
  const explicitMarker = /\[(?:truncated|cut|partial)\]\s*$/i.test(text);
  return {
    characters, utf8Bytes: Buffer.byteLength(text, 'utf8'), inspectedCharacters: index,
    inspectionComplete: complete, inspectionLimit: stopped,
    rootType, headTokens, tailTokens, tokenCount,
    omittedTokens: Math.max(0, tokenCount - headTokens.length - tailTokens.length),
    openStringAtEnd: complete ? openString : null,
    danglingEscapeAtEnd: complete ? danglingEscape : null,
    openContainersAtEnd: complete ? frames.length : null, maxDepthObserved: maxDepth,
    invalidEscapeObserved: invalidEscape, invalidUnicodeEscapeObserved: invalidUnicodeEscape,
    controlCharacterObserved: controlCharacter, bareTokenObserved: bareToken,
    mismatchedDelimiterObserved: delimiterMismatch, trailingContentObserved: trailingContent,
    truncation: explicitMarker ? 'explicit-marker' : complete && (openString || frames.length > 0)
      ? 'possible-incomplete-structure' : 'unknown',
  };
}
