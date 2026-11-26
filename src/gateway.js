import { createContext } from './core/context.js';
import { readJsonBody, sendJson } from './core/utils.js';
import { ValidationRejection, GatewayError } from './core/errors.js';

/**
 * 网关请求流水线。
 *
 * 链绑定点（关键）：view 在请求入口解析一次，之后整条请求 —— 包括 SSE 长连接的
 * 每一条事件 —— 都只通过 view.stageAt(slot) 取插件。view 是冻结对象，
 * 配置切换只改 store/rollout 的指针，不会触碰已发出的 view，因此：
 *   流进行中切换配置 -> 该流继续跑旧链；新请求 -> 只解析到新链。
 */
export function resolveView(store, rollout) {
  return rollout.currentView() ?? store.active();
}

function traceHeader(view) {
  if (view.mode === 'rolling') {
    return view.describeTrace().join(' -> ');
  }
  return view.plugins.map((s) => s.pluginId).join(' -> ');
}

function baseGatewayHeaders(view, ctx) {
  return {
    'x-gateway-chain': view.chainId ?? view.id,
    'x-gateway-rev': view.revLabel,
    'x-gateway-mode': view.mode,
    'x-gateway-context': `v${view.contextVersion}`,
    'x-gateway-trace': traceHeader(view),
    'x-gateway-request-id': ctx.requestId,
  };
}

export async function handleGatewayRequest(req, res, { store, rollout, upstreamBase }) {
  const view = resolveView(store, rollout);
  if (!view) {
    throw new GatewayError(503, 'no_active_chain', 'no active chain configured');
  }

  const url = new URL(req.url, 'http://gateway.local');
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req) : {};
  const ctx = createContext({
    view,
    method: req.method,
    path: url.pathname,
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])),
    query: Object.fromEntries(url.searchParams),
    body,
  });

  try {
    // ---- 请求阶段：request / both 类插件按槽位顺序执行 ----
    for (let slot = 0; slot < view.plugins.length; slot++) {
      const step = view.stageAt(slot);
      if (step.instance.kind === 'response') continue;
      await step.instance.onRequest(ctx);
    }
  } catch (err) {
    if (err instanceof ValidationRejection) {
      sendJson(res, 422, {
        error: {
          code: err.code,
          message: err.message,
          violations: err.violations,
          chain: err.chainTrace,
        },
      }, baseGatewayHeaders(view, ctx));
      return;
    }
    throw err;
  }

  const upstreamUrl = `${upstreamBase}${url.pathname}${url.search}`;
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: { 'content-type': 'application/json', 'x-gateway-request-id': ctx.requestId },
      body: ['POST', 'PUT', 'PATCH'].includes(req.method)
        ? JSON.stringify(ctx.request.body)
        : undefined,
    });
  } catch (err) {
    throw new GatewayError(502, 'upstream_unreachable', `upstream fetch failed: ${err.message}`);
  }

  const gwHeaders = baseGatewayHeaders(view, ctx);
  const contentType = upstream.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    await pipeSse(upstream, res, view, ctx, gwHeaders);
  } else {
    const payload = await upstream.json();
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8', ...gwHeaders });
    res.end(JSON.stringify(payload));
  }
}

/**
 * SSE 透传 + 每事件过响应阶段插件。
 * 注意 view/ctx 在整个连接期间不变 —— 这就是"流式请求继续使用旧链"的实现机制。
 */
async function pipeSse(upstream, res, view, ctx, gwHeaders) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...gwHeaders,
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const processEvent = async (rawEvent) => {
    const lines = rawEvent.split('\n');
    const event = { id: null, event: 'message', data: null };
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('id:')) event.id = line.slice(3).trim();
      else if (line.startsWith('event:')) event.event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    try {
      event.data = JSON.parse(dataLines.join('\n'));
    } catch {
      event.data = { raw: dataLines.join('\n') };
    }

    // 响应阶段：both 类插件逐槽位处理事件（链快照不变）。
    // 注意 field-removal 按原始 dotted path 作用于事件数据，
    // 因此在 SSE 路径上跳过协议封装，保证移除目标路径稳定可预期。
    for (let slot = 0; slot < view.plugins.length; slot++) {
      const step = view.stageAt(slot);
      if (step.instance.kind === 'request') continue;
      if (step.instance.id === 'protocol-transform') continue;
      if (typeof step.instance.onSseEvent === 'function') {
        await step.instance.onSseEvent(ctx, event);
      }
    }
    // 可验证的链绑定证据：每条事件都带当时的链标识
    event.data = { ...event.data, _gateway: { chain: view.revLabel, mode: view.mode, requestId: ctx.requestId } };

    res.write(`id:${event.id ?? ''}\nevent:${event.event}\ndata:${JSON.stringify(event.data)}\n\n`);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    // SSE 事件以空行分隔
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      await processEvent(raw);
    }
  }
  res.end();
}
