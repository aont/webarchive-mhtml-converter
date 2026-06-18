// Browser-side converter for Apple .webarchive <-> MHTML/MHT.
//
// Dependency: plist for parsing/building XML and binary plists.
// In production, prefer bundling this import with Vite/Rollup/esbuild instead of CDN imports.
// Pinning to plist@5.0.0 avoids the unavailable @plist/plist@1.1.0 CDN URL.
import {
  parse as parsePlist,
  build as buildXmlPlist,
  buildBinary as buildBinaryPlist,
} from 'https://esm.sh/plist@5.0.0';

const MHTML_SUFFIXES = new Set(['.mhtml', '.mht']);
const WEBARCHIVE_SUFFIXES = new Set(['.webarchive']);
const DEFAULT_BINARY_MIME = 'application/octet-stream';

const TEXT_LIKE_MIME_PREFIXES = ['text/'];
const TEXT_LIKE_MIME_TYPES = new Set([
  'application/javascript',
  'application/ecmascript',
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'image/svg+xml',
]);

const MIME_BY_EXT = new Map(Object.entries({
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.xhtml': 'application/xhtml+xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
}));

const UTF8_ENCODER = new TextEncoder();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function convertFile(file, options = {}) {
  const target = inferTarget(file.name, options.target ?? 'auto');
  if (target === 'webarchive') {
    return mhtmlFileToWebArchiveBlob(file, options);
  }
  if (target === 'mhtml') {
    return webArchiveFileToMhtmlBlob(file, options);
  }
  throw new Error(`Unsupported target: ${target}`);
}

export async function mhtmlFileToWebArchiveBlob(file, options = {}) {
  const archive = parseMhtml(await file.arrayBuffer(), {
    inlineCidCss: options.inlineCidCss !== false,
  });

  const plistFormat = options.plistFormat ?? 'binary';
  const built = plistFormat === 'xml'
    ? buildXmlPlist(archive)
    : buildBinaryPlist(archive);

  const bytes = typeof built === 'string'
    ? UTF8_ENCODER.encode(built)
    : new Uint8Array(built);

  const name = replaceExtension(file.name, '.webarchive');
  return {
    blob: new Blob([bytes], { type: 'application/x-webarchive' }),
    filename: name,
    archive,
  };
}

export async function webArchiveFileToMhtmlBlob(file, options = {}) {
  const archive = loadWebarchive(await file.arrayBuffer());
  const bytes = buildMhtml(archive, {
    sourceName: file.name,
    includeSubframes: options.includeSubframes !== false,
  });

  return {
    blob: new Blob([bytes], { type: 'multipart/related' }),
    filename: replaceExtension(file.name, '.mhtml'),
    archive,
  };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function normalizeMimeType(mimeType) {
  return String(mimeType || DEFAULT_BINARY_MIME).split(';', 1)[0].trim().toLowerCase();
}

function isTextLikeMime(mimeType) {
  const mt = normalizeMimeType(mimeType);
  return TEXT_LIKE_MIME_PREFIXES.some((prefix) => mt.startsWith(prefix)) || TEXT_LIKE_MIME_TYPES.has(mt);
}

function suffixOf(filename) {
  const m = /(?:^|\/)([^/]+)$/.exec(filename || '');
  const base = m ? m[1] : filename;
  const idx = base.lastIndexOf('.');
  return idx >= 0 ? base.slice(idx).toLowerCase() : '';
}

function kindFromName(filename) {
  const suffix = suffixOf(filename);
  if (WEBARCHIVE_SUFFIXES.has(suffix)) return 'webarchive';
  if (MHTML_SUFFIXES.has(suffix)) return 'mhtml';
  return null;
}

function inferTarget(filename, requestedTarget = 'auto') {
  if (requestedTarget !== 'auto') return requestedTarget;
  const inputKind = kindFromName(filename);
  if (inputKind === 'webarchive') return 'mhtml';
  if (inputKind === 'mhtml') return 'webarchive';
  throw new Error('Could not infer conversion direction. Use target: "mhtml" or target: "webarchive".');
}

function replaceExtension(filename, ext) {
  const base = filename.replace(/\.[^.\/\\]+$/, '');
  return `${base}${ext}`;
}

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError(`Expected ArrayBuffer or Uint8Array, got ${typeof input}`);
}

function exactArrayBuffer(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer.slice(0);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function bytesToByteString(bytes) {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeDecode(bytes, encoding = 'utf-8') {
  try {
    return new TextDecoder(encoding || 'utf-8', { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

function utf8Bytes(s) {
  return UTF8_ENCODER.encode(s);
}

function pathFromUrlLike(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return String(url || '').split(/[?#]/, 1)[0].toLowerCase();
  }
}

function guessMimeFromUrl(url) {
  const path = pathFromUrlLike(url);
  const m = /\.[a-z0-9]+$/i.exec(path);
  return m ? MIME_BY_EXT.get(m[0].toLowerCase()) : undefined;
}

function fixMimeType(url, mime) {
  const mt = normalizeMimeType(mime);
  const path = pathFromUrlLike(url);
  const guessed = guessMimeFromUrl(url);

  if (path.endsWith('.css') && mt !== 'text/css') return 'text/css';
  if (path.endsWith('.js') && (mt === 'text/plain' || mt === DEFAULT_BINARY_MIME)) return 'application/javascript';
  if (guessed && mt === DEFAULT_BINARY_MIME) return normalizeMimeType(guessed);
  return mt;
}

function isAbsoluteOrCid(url) {
  if (String(url).startsWith('cid:')) return true;
  try {
    return Boolean(new URL(url).protocol);
  } catch {
    return false;
  }
}

function urlJoin(baseUrl, loc) {
  try {
    return new URL(loc, baseUrl).href;
  } catch {
    return loc;
  }
}

// ---------------------------------------------------------------------------
// Minimal MIME parser for MHTML/MHT
// ---------------------------------------------------------------------------

function parseHeaderBlock(headerText) {
  const physicalLines = headerText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const logicalLines = [];

  for (const line of physicalLines) {
    if (/^[ \t]/.test(line) && logicalLines.length) {
      logicalLines[logicalLines.length - 1] += ` ${line.trim()}`;
    } else if (line.trim() !== '') {
      logicalLines.push(line);
    }
  }

  const map = new Map();
  for (const line of logicalLines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(value);
  }

  return {
    get(name) {
      const values = map.get(String(name).toLowerCase());
      return values && values.length ? values[0] : undefined;
    },
    getAll(name) {
      return map.get(String(name).toLowerCase()) ?? [];
    },
    entries() {
      return map.entries();
    },
  };
}

function splitHeaderParameters(value) {
  const parts = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const ch of String(value || '')) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote) {
      current += ch;
      escaped = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? null : ch;
      current += ch;
      continue;
    }
    if (ch === ';' && !quote) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

function unquote(value) {
  const s = String(value ?? '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\([\\"'])/g, '$1');
  }
  return s;
}

function parseContentType(value) {
  const parts = splitHeaderParameters(value || 'text/plain');
  const type = normalizeMimeType(parts.shift() || 'text/plain');
  const params = new Map();
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    params.set(part.slice(0, idx).trim().toLowerCase(), unquote(part.slice(idx + 1)));
  }
  return { type, params };
}

function normalizeCid(value) {
  if (!value) return null;
  let v = String(value).trim();
  if (v.startsWith('<') && v.endsWith('>')) v = v.slice(1, -1);
  return v || null;
}

function cidUrlFromPart(part) {
  const cid = normalizeCid(part.headers.get('content-id'));
  return cid ? `cid:${cid}` : null;
}

function findHeaderSeparator(text, start = 0, end = text.length) {
  const crlf = text.indexOf('\r\n\r\n', start);
  const lf = text.indexOf('\n\n', start);
  const candidates = [];
  if (crlf >= 0 && crlf < end) candidates.push({ index: crlf, length: 4 });
  if (lf >= 0 && lf < end) candidates.push({ index: lf, length: 2 });
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0] ?? { index: -1, length: 0 };
}

function parseMimePart(partBytes) {
  const text = bytesToByteString(partBytes);
  const sep = findHeaderSeparator(text);
  if (sep.index < 0) {
    throw new Error('Invalid MIME part: missing header/body separator');
  }
  const headerText = text.slice(0, sep.index);
  const bodyStart = sep.index + sep.length;
  const headers = parseHeaderBlock(headerText);
  const bodyBytes = partBytes.subarray(bodyStart);
  const contentType = parseContentType(headers.get('content-type') || DEFAULT_BINARY_MIME);

  return {
    headers,
    contentType,
    data: decodeTransferEncoding(bodyBytes, headers.get('content-transfer-encoding')),
  };
}

function decodeTransferEncoding(bodyBytes, encodingHeader) {
  const enc = String(encodingHeader || '').trim().toLowerCase();
  if (enc === 'base64') return decodeBase64Bytes(bodyBytes);
  if (enc === 'quoted-printable') return decodeQuotedPrintableBytes(bodyBytes);
  return stripTrailingLinebreaks(bodyBytes);
}

function stripTrailingLinebreaks(bytes) {
  let end = bytes.length;
  if (end >= 2 && bytes[end - 2] === 13 && bytes[end - 1] === 10) end -= 2;
  else if (end >= 1 && bytes[end - 1] === 10) end -= 1;
  return bytes.subarray(0, end);
}

function decodeBase64Bytes(bodyBytes) {
  const b64 = bytesToByteString(bodyBytes).replace(/[\t\r\n ]+/g, '');
  if (!b64) return new Uint8Array();
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

function hexValue(byte) {
  if (byte >= 48 && byte <= 57) return byte - 48;
  if (byte >= 65 && byte <= 70) return byte - 55;
  if (byte >= 97 && byte <= 102) return byte - 87;
  return -1;
}

function decodeQuotedPrintableBytes(bodyBytes) {
  const out = [];
  for (let i = 0; i < bodyBytes.length; i += 1) {
    const b = bodyBytes[i];
    if (b !== 61 /* = */) {
      out.push(b);
      continue;
    }

    const n1 = bodyBytes[i + 1];
    const n2 = bodyBytes[i + 2];

    // Soft line break: =\r\n or =\n.
    if (n1 === 13 && n2 === 10) {
      i += 2;
      continue;
    }
    if (n1 === 10) {
      i += 1;
      continue;
    }

    const h1 = hexValue(n1);
    const h2 = hexValue(n2);
    if (h1 >= 0 && h2 >= 0) {
      out.push((h1 << 4) | h2);
      i += 2;
      continue;
    }

    out.push(b);
  }
  return new Uint8Array(out);
}

function findMultipartBoundaries(text, boundary) {
  const re = new RegExp(`(?:^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[^\\r\\n]*(?:\\r?\\n|$)`, 'g');
  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    let lineStart = m.index;
    if (raw.startsWith('\r\n')) lineStart += 2;
    else if (raw.startsWith('\n')) lineStart += 1;
    matches.push({
      lineStart,
      afterLine: m.index + raw.length,
      closing: Boolean(m[1]),
    });
  }
  return matches;
}

function parseMultipartRelated(bytes) {
  const text = bytesToByteString(bytes);
  const topSep = findHeaderSeparator(text);
  if (topSep.index < 0) throw new Error('Invalid MHTML: missing top-level headers');

  const topHeaders = parseHeaderBlock(text.slice(0, topSep.index));
  const topContentType = parseContentType(topHeaders.get('content-type') || '');
  const boundary = topContentType.params.get('boundary');
  if (!boundary) throw new Error('Invalid MHTML: missing multipart boundary');

  const boundaries = findMultipartBoundaries(text, boundary);
  if (boundaries.length < 2) throw new Error('Invalid MHTML: no MIME parts found');

  const parts = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const current = boundaries[i];
    const next = boundaries[i + 1];
    if (current.closing) break;
    const rawPartBytes = bytes.subarray(current.afterLine, next.lineStart);
    const partBytes = stripTrailingLinebreaks(rawPartBytes);
    if (partBytes.length) parts.push(parseMimePart(partBytes));
  }

  return { topHeaders, topContentType, parts };
}

function chooseRootPart(message) {
  const start = normalizeCid(message.topContentType.params.get('start'));
  if (start) {
    const byStart = message.parts.find((part) => normalizeCid(part.headers.get('content-id')) === start);
    if (byStart) return byStart;
  }

  const html = message.parts.find((part) => {
    const type = part.contentType.type;
    return type === 'text/html' || type === 'application/xhtml+xml';
  });
  if (html) return html;

  throw new Error('No HTML root part found in MHTML');
}

function textEncodingFromContentType(contentTypeHeader) {
  const ct = parseContentType(contentTypeHeader || '');
  return ct.params.get('charset') || 'utf-8';
}

function makeWebResource(url, mime, dataBytes, contentTypeHeader) {
  const fixedMime = fixMimeType(url, mime);
  let data = dataBytes;
  if (isTextLikeMime(fixedMime)) data = stripTrailingNuls(data);

  const resource = {
    WebResourceURL: url,
    WebResourceMIMEType: fixedMime,
    WebResourceData: new Uint8Array(data),
  };

  if (isTextLikeMime(fixedMime)) {
    resource.WebResourceTextEncodingName = textEncodingFromContentType(contentTypeHeader || fixedMime);
  }

  return resource;
}

function stripTrailingNuls(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return bytes.subarray(0, end);
}

function mhtmlPartUrl(part, baseUrl, index) {
  const loc = (part.headers.get('content-location') || '').trim();
  if (loc) {
    if (isAbsoluteOrCid(loc)) return loc;
    if (baseUrl) return urlJoin(baseUrl, loc);
    return loc;
  }

  const cid = cidUrlFromPart(part);
  if (cid) return cid;
  return `mhtml-resource-${index}`;
}

export function parseMhtml(input, options = {}) {
  const bytes = toUint8Array(input);
  const message = parseMultipartRelated(bytes);
  const parts = message.parts;
  if (!parts.length) throw new Error('Input is not multipart MHTML');

  const root = chooseRootPart(message);
  const snapshotUrl = (message.topHeaders.get('snapshot-content-location') || '').trim() || null;
  const rootLoc = (root.headers.get('content-location') || '').trim() || snapshotUrl;
  const rootUrl = rootLoc || cidUrlFromPart(root) || 'about:blank';

  const mainMime = root.contentType.type || 'text/html';
  const mainResource = makeWebResource(rootUrl, mainMime, root.data, root.headers.get('content-type'));

  const subresources = [];
  parts.forEach((part, idx) => {
    if (part === root) {
      const cid = cidUrlFromPart(part);
      if (cid && cid !== rootUrl) {
        subresources.push(makeWebResource(cid, mainMime, root.data, part.headers.get('content-type')));
      }
      return;
    }

    const url = mhtmlPartUrl(part, rootUrl, idx + 1);
    const mime = part.contentType.type || DEFAULT_BINARY_MIME;
    subresources.push(makeWebResource(url, mime, part.data, part.headers.get('content-type')));

    const cid = cidUrlFromPart(part);
    if (cid && cid !== url) {
      subresources.push(makeWebResource(cid, mime, part.data, part.headers.get('content-type')));
    }

    const rawLoc = (part.headers.get('content-location') || '').trim();
    if (rawLoc && rawLoc !== url && !isAbsoluteOrCid(rawLoc)) {
      subresources.push(makeWebResource(rawLoc, mime, part.data, part.headers.get('content-type')));
    }
  });

  const archive = {
    WebMainResource: mainResource,
    WebSubresources: subresources,
  };

  if (options.inlineCidCss !== false) inlineCidStylesheets(archive);
  return archive;
}

function stripInlineCharset(css) {
  return css.replace(/^\s*@charset\s+["'][^"']+["']\s*;\s*/i, '');
}

function replaceStylesheetLink(html, url, cssText) {
  const styleTag = `<style type="text/css">\n${stripInlineCharset(cssText)}\n</style>`;
  const hrefPat = new RegExp(`\\bhref\\s*=\\s*(["'])${escapeRegExp(url)}\\1`, 'i');
  const relPat = /\brel\s*=\s*(["'])[^"']*stylesheet[^"']*\1/i;

  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (hrefPat.test(tag) && relPat.test(tag)) return styleTag;
    return tag;
  });
}

function inlineCidStylesheets(archive) {
  const resources = [archive.WebMainResource, ...(archive.WebSubresources || [])];
  const cidCss = [];

  for (const resource of resources) {
    if (resource?.WebResourceMIMEType !== 'text/css') continue;
    if (!String(resource.WebResourceURL || '').startsWith('cid:')) continue;

    const bytes = decodeWebResourceData(resource.WebResourceData);
    const encoding = resource.WebResourceTextEncodingName || 'utf-8';
    cidCss.push([resource.WebResourceURL, safeDecode(bytes, encoding)]);
  }

  if (!cidCss.length) return;

  for (const resource of resources) {
    const mime = resource?.WebResourceMIMEType;
    if (mime !== 'text/html' && mime !== 'application/xhtml+xml') continue;

    const encoding = resource.WebResourceTextEncodingName || 'utf-8';
    let html = safeDecode(decodeWebResourceData(resource.WebResourceData), encoding);
    for (const [url, css] of cidCss) html = replaceStylesheetLink(html, url, css);

    // TextEncoder only writes UTF-8. Keep the data internally consistent.
    resource.WebResourceData = new Uint8Array(utf8Bytes(html));
    resource.WebResourceTextEncodingName = 'utf-8';
  }
}

// ---------------------------------------------------------------------------
// WebArchive -> MHTML
// ---------------------------------------------------------------------------

export function loadWebarchive(input) {
  const archive = parsePlist(input instanceof ArrayBuffer ? input : exactArrayBuffer(toUint8Array(input)));
  if (!archive || typeof archive !== 'object' || Array.isArray(archive)) {
    throw new Error('Invalid webarchive: root object is not a dictionary');
  }
  if (!archive.WebMainResource || typeof archive.WebMainResource !== 'object') {
    throw new Error('Invalid webarchive: missing WebMainResource');
  }
  return archive;
}

function decodeWebResourceData(value) {
  if (value == null) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const maybeBase64 = tryDecodeBase64String(trimmed);
    if (maybeBase64) return maybeBase64;
    return utf8Bytes(value);
  }

  if (typeof value === 'object') {
    for (const key of ['bytes', 'data', 'base64', 'WebResourceData']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) return decodeWebResourceData(value[key]);
    }
  }

  throw new TypeError(`Unsupported WebResourceData type: ${Object.prototype.toString.call(value)}`);
}

function tryDecodeBase64String(s) {
  if (!s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s.replace(/\s+/g, ''))) return null;
  try {
    const compact = s.replace(/\s+/g, '');
    const padded = compact + '='.repeat((4 - (compact.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i) & 0xff;

    // Avoid misclassifying ordinary short strings as base64.
    const normalized = btoa(bytesToByteString(out)).replace(/=+$/, '');
    return normalized === compact.replace(/=+$/, '') ? out : null;
  } catch {
    return null;
  }
}

function guessMimeType(resource, data, isMain) {
  const explicit = resource?.WebResourceMIMEType;
  if (typeof explicit === 'string' && explicit.trim()) return normalizeMimeType(explicit);

  const url = resource?.WebResourceURL;
  if (typeof url === 'string') {
    const guessed = guessMimeFromUrl(url);
    if (guessed) return normalizeMimeType(guessed);
  }

  if (isMain) return 'text/html';

  if (startsWithBytes(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWithBytes(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWithAscii(data, 'GIF87a') || startsWithAscii(data, 'GIF89a')) return 'image/gif';
  if (startsWithAscii(data, 'RIFF') && bytesToByteString(data.subarray(8, 12)) === 'WEBP') return 'image/webp';
  if (startsWithBytes(data, [0x00, 0x00, 0x00]) && bytesToByteString(data.subarray(0, 32)).includes('ftypavif')) return 'image/avif';
  if (startsWithAscii(data, 'wOFF')) return 'font/woff';
  if (startsWithAscii(data, 'wOF2')) return 'font/woff2';

  const trimmed = trimLeadingAsciiWhitespace(data);
  if (startsWithAscii(trimmed, '<svg') || startsWithAscii(trimmed, '<?xml')) return 'image/svg+xml';

  return DEFAULT_BINARY_MIME;
}

function startsWithBytes(data, prefix) {
  if (data.length < prefix.length) return false;
  return prefix.every((b, i) => data[i] === b);
}

function startsWithAscii(data, prefix) {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (data[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

function trimLeadingAsciiWhitespace(data) {
  let i = 0;
  while (i < data.length && (data[i] === 9 || data[i] === 10 || data[i] === 13 || data[i] === 32)) i += 1;
  return data.subarray(i);
}

function getCharset(resource, mimeType) {
  const encoding = resource?.WebResourceTextEncodingName;
  if (typeof encoding === 'string' && encoding.trim()) return encoding.trim();
  return isTextLikeMime(mimeType) ? 'utf-8' : null;
}

function contentLocation(resource, fallback) {
  const url = resource?.WebResourceURL;
  if (typeof url === 'string' && url.trim()) return url.trim();
  return fallback;
}

function percentEncodeNonAscii(value) {
  let out = '';
  for (const ch of value) {
    if (ch.codePointAt(0) <= 0x7f) out += ch;
    else out += encodeURIComponent(ch);
  }
  return out;
}

function sanitizeHeaderValue(value) {
  return percentEncodeNonAscii(String(value).replace(/[\r\n]/g, ''));
}

function foldHeaderLine(name, value, limit = 998) {
  const prefix = `${name}: `;
  const raw = sanitizeHeaderValue(value);
  const line = prefix + raw;
  if (asciiBytes(line).length <= limit) return asciiBytes(`${line}\r\n`);

  const chunks = [];
  let current = prefix;
  const tokens = raw.split(/([/?&=#.;,:_-])/);
  for (const token of tokens) {
    if (token === '') continue;
    const candidate = current + token;
    if (asciiBytes(candidate).length <= limit) {
      current = candidate;
    } else {
      chunks.push(asciiBytes(`${current}\r\n`));
      current = ` ${token}`;
    }
  }
  if (current) chunks.push(asciiBytes(`${current}\r\n`));
  return concatBytes(chunks);
}

function makeContentType(mimeType, charset) {
  if (charset && isTextLikeMime(mimeType)) return `${mimeType}; charset="${charset}"`;
  return mimeType;
}

function base64FromBytes(data) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function wrapBase64(data) {
  const b64 = base64FromBytes(data);
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return asciiBytes(`${lines.join('\r\n')}\r\n`);
}

function makeMhtmlPart({ data, mimeType, charset, location, contentId = null }) {
  const headers = [
    foldHeaderLine('Content-Type', makeContentType(mimeType, charset)),
    asciiBytes('Content-Transfer-Encoding: base64\r\n'),
    foldHeaderLine('Content-Location', location),
  ];
  if (contentId) headers.push(foldHeaderLine('Content-ID', `<${contentId}>`));
  headers.push(asciiBytes('\r\n'));
  headers.push(wrapBase64(data));
  return concatBytes(headers);
}

function* iterArchiveResources(archive, { includeSubframes, prefix = '' } = {}) {
  const main = archive?.WebMainResource;
  if (main && typeof main === 'object') yield [main, true, `${prefix}main-resource`];

  const subresources = archive?.WebSubresources || archive?.WebSubResources || [];
  if (Array.isArray(subresources)) {
    subresources.forEach((resource, index) => {
      if (resource && typeof resource === 'object') {
        // Cannot yield inside forEach, handled below by returning through a temp array.
      }
    });
    for (let i = 0; i < subresources.length; i += 1) {
      const resource = subresources[i];
      if (resource && typeof resource === 'object') yield [resource, false, `${prefix}resource-${i + 1}`];
    }
  }

  if (includeSubframes) {
    const subframes = archive?.WebSubframeArchives || [];
    if (Array.isArray(subframes)) {
      for (let i = 0; i < subframes.length; i += 1) {
        const subarchive = subframes[i];
        if (subarchive && typeof subarchive === 'object') {
          yield* iterArchiveResources(subarchive, {
            includeSubframes: true,
            prefix: `${prefix}frame-${i + 1}-`,
          });
        }
      }
    }
  }
}

export function buildMhtml(archive, options = {}) {
  const sourceName = options.sourceName ?? 'archive.webarchive';
  const includeSubframes = options.includeSubframes !== false;
  const boundary = `----=_NextPart_${makeUuidLike()}`;
  const boundaryBytes = asciiBytes(boundary);

  const resources = Array.from(iterArchiveResources(archive, { includeSubframes }));
  if (!resources.length) throw new Error('Invalid webarchive: no resources found');

  const [mainResource] = resources[0];
  const mainData = decodeWebResourceData(mainResource.WebResourceData);
  const mainMime = guessMimeType(mainResource, mainData, true);

  const chunks = [];
  chunks.push(asciiBytes('MIME-Version: 1.0\r\n'));
  chunks.push(foldHeaderLine('Subject', `Converted from ${sourceName}`));
  chunks.push(foldHeaderLine(
    'Content-Type',
    `multipart/related; type="${mainMime}"; start="<main-resource>"; boundary="${boundary}"`,
  ));
  chunks.push(asciiBytes('\r\nThis is a multi-part message in MIME format.\r\n'));

  const seenLocations = new Set();
  resources.forEach(([resource, isMain, fallbackLocation], resourceIndex) => {
    const data = decodeWebResourceData(resource.WebResourceData);
    if (!data.length) return;

    const mimeType = guessMimeType(resource, data, isMain);
    const charset = getCharset(resource, mimeType);
    const location = contentLocation(resource, fallbackLocation);
    if (seenLocations.has(location)) return;
    seenLocations.add(location);

    chunks.push(asciiBytes('\r\n--'));
    chunks.push(boundaryBytes);
    chunks.push(asciiBytes('\r\n'));
    chunks.push(makeMhtmlPart({
      data,
      mimeType,
      charset,
      location,
      contentId: resourceIndex === 0 ? 'main-resource' : null,
    }));
  });

  chunks.push(asciiBytes('\r\n--'));
  chunks.push(boundaryBytes);
  chunks.push(asciiBytes('--\r\n'));
  return concatBytes(chunks);
}

function makeUuidLike() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
