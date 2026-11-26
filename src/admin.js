import { readJsonBody, sendJson, sendError } from './core/utils.js';
import { GatewayError } from './core/errors.js';
import { listPluginSpecs } from './plugins/index.js';

/**
 * 管理面 HTTP API（与数据面同端口，/admin 前缀）。
 * 所有写操作都经过状态机：draft -> confirm(preflight) -> deploy/rollout。
 */
export function createAdminHandler({ store, rollout }) {
  return async function adminHandler(req, res) {
    const url = new URL(req.url, 'http://admin.local');
    const segments = url.pathname.split('/').filter(Boolean); // ["admin", ...]
    const method = req.method;

    try {
      // ---- 只读 ----
      if (method === 'GET' && url.pathname === '/admin/state') {
        return sendJson(res, 200, { ...store.state(), rollout: rollout.status() });
      }
      if (method === 'GET' && url.pathname === '/admin/plugins') {
        return sendJson(res, 200, { plugins: listPluginSpecs() });
      }
      if (method === 'GET' && segments[1] === 'chains' && segments[2]) {
        return sendJson(res, 200, store.get(segments[2]).describe());
      }

      // ---- 草稿 / 确认 ----
      if (method === 'PUT' && segments[1] === 'chains') {
        const body = await readJsonBody(req);
        const snapshot = store.saveDraft(body);
        return sendJson(res, 201, { ok: true, chain: snapshot.describe(),
          note: 'saved as draft; call /confirm to run the compatibility gate' });
      }
      if (method === 'POST' && segments[1] === 'chains' && segments[3] === 'confirm') {
        const snapshot = store.confirm(segments[2]); // 不兼容抛 409
        return sendJson(res, 200, { ok: true, chain: snapshot.describe() });
      }

      // ---- 原子热切换 / 回退 ----
      if (method === 'POST' && url.pathname === '/admin/deploy') {
        const body = await readJsonBody(req);
        if (!body.id) throw new GatewayError(400, 'bad_request', 'body requires chain id');
        const result = store.deploy(body.id, { reason: body.reason });
        return sendJson(res, 200, {
          ok: true,
          active: result.active.revLabel,
          previous: result.previous?.revLabel ?? null,
          record: result.record,
        });
      }
      if (method === 'POST' && url.pathname === '/admin/rollback') {
        const body = await readJsonBody(req).catch(() => ({}));
        const result = store.rollback(body.targetId ?? null);
        return sendJson(res, 200, {
          ok: true,
          active: result.active.revLabel,
          previous: result.previous?.revLabel ?? null,
          record: result.record,
        });
      }

      // ---- 逐插件滚动替换 ----
      if (method === 'POST' && url.pathname === '/admin/rollout/start') {
        const body = await readJsonBody(req);
        if (!body.targetId) throw new GatewayError(400, 'bad_request', 'body requires targetId');
        return sendJson(res, 200, { ok: true, rollout: rollout.start(body.targetId) });
      }
      if (method === 'POST' && url.pathname === '/admin/rollout/advance') {
        const body = await readJsonBody(req).catch(() => ({}));
        return sendJson(res, 200, { ok: true, rollout: rollout.advance(body.slot ?? null) });
      }
      if (method === 'POST' && url.pathname === '/admin/rollout/rollback') {
        return sendJson(res, 200, { ok: true, ...rollout.rollback() });
      }
      if (method === 'GET' && url.pathname === '/admin/rollout') {
        return sendJson(res, 200, rollout.status());
      }

      // ---- 变更事件流（调试页自动刷新用）----
      if (method === 'GET' && url.pathname === '/admin/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const send = (payload) => res.write(`data:${JSON.stringify(payload)}\n\n`);
        send({ type: 'hello', at: new Date().toISOString() });
        const onStore = (e) => send({ source: 'store', ...e });
        const onRollout = (e) => send({ source: 'rollout', ...e });
        store.on('changed', onStore);
        rollout.on('changed', onRollout);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          store.off('changed', onStore);
          rollout.off('changed', onRollout);
        });
        return;
      }

      throw new GatewayError(404, 'admin_not_found', `no admin route for ${method} ${url.pathname}`);
    } catch (err) {
      sendError(res, err);
    }
  };
}
