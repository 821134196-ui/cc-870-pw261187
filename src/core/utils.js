import { GatewayError } from './errors.js';

/** 递归冻结，链快照与插件实例一旦构建即不可变。 */
export function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  for (const key of Reflect.ownKeys(obj)) {
    const v = obj[key];
    if (v !== null && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(obj);
}

/** 按 dotted path 取值，如 a.b.c；任一层缺失返回 undefined。 */
export function getPath(obj, path) {
  return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

/** 按 dotted path 删值（删除成功返回 true）。数组下标也支持。 */
export function deletePath(obj, path) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return false;
    cur = cur[keys[i]];
  }
  if (cur != null && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, keys.at(-1))) {
    delete cur[keys.at(-1)];
    return true;
  }
  return false;
}

/** 读取并解析 JSON 请求体，限制 1MB。 */
export async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new GatewayError(413, 'body_too_large', `body exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new GatewayError(400, 'invalid_json', 'request body is not valid JSON');
  }
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    ...extraHeaders,
  });
  res.end(buf);
}

export function sendError(res, err) {
  if (err instanceof GatewayError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
  } else {
    sendJson(res, 500, { error: { code: 'internal_error', message: err?.message ?? 'internal error' } });
  }
}

export function nowIso() {
  return new Date().toISOString();
}
