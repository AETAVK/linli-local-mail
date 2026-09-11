// Optional diagnostic fragments retain song structure, NOT original bytes or anonymity.
// Unsupported credential-bearing grammar is omitted, never returned as raw fallback.
export const FRAGMENT_POLICY = 'targeted-credentials-v2';
export const REDACTED = '[REDACTED]';
const defaults = Object.freeze({ bytes: 32768, depth: 12, nodes: 4096, stringBytes: 16384, textBudget: 131072 });
const normalize = key => String(key).normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
const BUSINESS = new Set(['name','namekey','filename','id','songid','jobid','itemid','taskid','queryaction','action','code','reason','stage','phase','evidence','algorithm','policy']);
const JSON_CONTEXT = new Set(['queryrequest','queryresponse','request','response','body','payload','data','result','inventoryjson','resultjson','valuejson','filesjson']);
export function credentialKey(key) {
  const name = normalize(key);
  return /(?:token|authorization|cookie|password|passwd|passphrase|apikey|secret|credential|signature|privatekey|accesskey)(?:s|id|value|header)?$/.test(name) ||
    /^(?:pwd|auth|authkey|authcode|authorizationcode|sig|session|sessionid|sessionkey|jwt|xcsrf|xxsrf|ossaccesskeyid|awsaccesskeyid|口令|密码|密钥|令牌)$/.test(name) ||
    /^(?:xamz|xoss|xgoog)(?:securitytoken|credential|signature|algorithm|signedheaders)$/.test(name);
}
export function redactSongFragment(line, limits = {}) {
  const budget = { ...defaults, ...limits };
  let nodes = 0, strings = 0, redactions = 0;const redactionReasons={};
  const fail = reason => { throw new Error(reason); };
  const mask = (reason='credential-value') => { redactions++;redactionReasons[reason]=(redactionReasons[reason]||0)+1; return REDACTED; };
  function decoded(value) {
    try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { fail('invalid-encoding'); }
  }
  function url(value) {
    // URI parsing can silently retain malformed escapes. Reject those before parsing.
    if (/%(?![\da-f]{2})/i.test(value)) fail('invalid-encoding');
    const match=/^(\s*https?:\/\/)([^/\s?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(value);
    if(!match)fail('unsupported-url');
    let authority=match[2];if(authority.includes('@')){authority=authority.slice(authority.lastIndexOf('@')+1);mask('url-userinfo');}
    let query=match[4]||'';
    if(query){const pairs=query.slice(1).split('&');if(pairs.length>128)fail('budget-exceeded');query='?'+pairs.map(pair=>{
      const index=pair.indexOf('='),rawKey=index<0?pair:pair.slice(0,index),key=decoded(rawKey);if(key.length>256)fail('budget-exceeded');
      const rawValue=index<0?'':pair.slice(index+1),compareValue=decoded(rawValue);
      const safeSelector=/^(?:id|nameKey|tod|view)$/i.test(key)||/^format$/i.test(key)&&/^(?:|mp4|webm|midi|mid|json|xml|text|png|jpg|jpeg|avif|m3u8|mp3|aac|wav|ogg|flac)$/i.test(compareValue)||/^version$/i.test(key)&&/^(?:|v?\d{1,4}(?:[._-]\d{1,4}){0,5}(?:[-+][a-z0-9._-]{1,32})?)$/i.test(compareValue);
      if(safeSelector&&!credentialKey(key))return pair;
      return rawKey+'='+encodeURIComponent(mask(credentialKey(key)?'credential-query-value':'unclassified-query-value'));
    }).join('&');}
    if(match[5])mask('url-fragment');return match[1]+authority+mediaPath(match[3])+query;
  }
  function mediaPath(value) {
    const original=value;let units=[];
    for(let i=0;i<value.length;i++)units.push({c:value[i],start:i,end:i+1});
    for(let round=0;round<3;round++){
      const next=[];let changed=false;
      for(let i=0;i<units.length;i++){
        if(units[i].c==='%'&&/^[\da-f]{2}$/i.test((units[i+1]?.c||'')+(units[i+2]?.c||''))){next.push({c:String.fromCharCode(parseInt(units[i+1].c+units[i+2].c,16)),start:units[i].start,end:units[i+2].end});i+=2;changed=true;}
        else next.push(units[i]);
      }units=next;if(!changed)break;
    }
    value=units.map(u=>u.c).join('');if(/%[\da-f]{2}/i.test(value))fail('unsupported-encoded-text');
    const ranges=[];for(const match of value.matchAll(/([/\\]custom-song-media[/\\])([^/\\\s?#]+)/gi)){
      const start=match.index+match[1].length,end=start+match[2].length;ranges.push([units[start].start,units[end-1].end]);
    }
    let result=original;for(const [start,end] of ranges.reverse())result=result.slice(0,start)+mask('local-media-token')+result.slice(end);return result;
  }
  function text(value, depth, key = '') {
    strings += Buffer.byteLength(value);
    if (Buffer.byteLength(value) > budget.stringBytes || strings > budget.textBudget || depth > budget.depth) fail('budget-exceeded');
    const trimmed = value.trim();
    const field=normalize(key);
    if((BUSINESS.has(field)&&!['reason','stage','phase','code'].includes(field))||/(?:name|title)$/.test(field))return value;
    // Probe only non-business credential text. Decoding is for detection, never a replacement value.
    if(!/^[\[{\"]/.test(trimmed)){
    let probe=trimmed;
    for(let round=0;round<3&&/%[\da-f]{2}/i.test(probe);round++){try{probe=decodeURIComponent(probe);}catch{break;}}
    if(/(?:^|[\s:])(?:Bearer|Basic)[\t ]+\S+/i.test(probe)||/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(probe))return mask('authorization-text');
    if(/^(?:error|queryerror|message|headers?|authorization)$/.test(field)&&/%[\da-f]{2}/i.test(probe))fail('unsupported-encoded-text');
    }
    if(BUSINESS.has(field))return value;
    // JSON string payloads remain strings, but their decoded values/keys are processed recursively.
    if (JSON_CONTEXT.has(field) && /^[\[{\"]/.test(trimmed) && trimmed !== REDACTED) {
      let inner; try { inner = JSON.parse(trimmed); } catch { fail('malformed-json-string'); }
      return JSON.stringify(walk(inner, depth + 1));
    }
    if(!JSON_CONTEXT.has(field)&&!['header','headers'].includes(field)){
      if(/^\s*https?:\/\//i.test(value))return url(value);
      if(/(?:path|url|uri|href|src)$/.test(field))return mediaPath(value);
      if(/^[\[{\"]/.test(trimmed)){
        let parsed;try{parsed=JSON.parse(trimmed);}catch{if(/(?:token|authorization|cookie|password|api.?key|secret)\s*["':=]/i.test(value))fail('unsupported-sensitive-text');return value;}
        const before=redactions,clean=walk(parsed,depth+1);return redactions>before?JSON.stringify(clean):value;
      }
      const header=trimmed.match(/^([\w-]+)\s*:/);
      if(!header||!credentialKey(header[1])){
        if(/(?:token|authorization|cookie|password|api.?key|secret)\s*[:=]/i.test(trimmed))fail('unsupported-sensitive-text');
        return value;
      }
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
  function walk(value, depth, key = '') {
    if (++nodes > budget.nodes || depth > budget.depth) fail('budget-exceeded');
    if (typeof value === 'string') return text(value, depth, key);
    if (Array.isArray(value)) {
      if (value.length === 2 && typeof value[0] === 'string' && credentialKey(value[0])) return [value[0], mask()];
      return value.map(item => walk(item, depth + 1, key));
    }
    if (!value || typeof value !== 'object') return value;
    const entries = Object.entries(value);
    const headerPair = entries.some(([key, val]) => /^(?:name|key|headername)$/i.test(normalize(key)) && typeof val === 'string' && credentialKey(val));
    return Object.fromEntries(entries.map(([key, val]) => {
      if (key.length > 256) fail('budget-exceeded');
      return [key, credentialKey(key) || ['imagedata','pixels','thumbnail','screenshot','videodata','imagebase64','base64','rawframes'].includes(normalize(key)) || headerPair && /^(?:value|values|headervalue)$/.test(normalize(key)) ? mask() : walk(val, depth + 1, key)];
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
    return { ok: true, text: output, redactions, redactionReasons, policy: FRAGMENT_POLICY, contentKind: 'credential-redacted-fragment' };
  } catch (error) {
    const reason = ['budget-exceeded','invalid-encoding','unsupported-url','malformed-json-string','unsupported-sensitive-text','unsupported-encoded-text','missing-marker','malformed-outer-json','unsupported-outer'].includes(error.message) ? error.message : 'unsafe-fragment';
    return { ok: false, reason, policy: FRAGMENT_POLICY };
  }
}

export function redactDiagnosticValue(value,limits={}) {
  const result=redactSongFragment('[OTEL Logger] '+JSON.stringify({data:value}),limits);
  if(!result.ok)return result;
  return {...result,value:JSON.parse(result.text.slice('[OTEL Logger] '.length)).data};
}
