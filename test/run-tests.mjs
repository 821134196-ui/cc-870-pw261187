/**
 * 端到端测试（零依赖，node test/run-tests.mjs）。
 * 覆盖：插件能力、已确认链约束、原子热切换、SSE 流钉旧链、滚动混合视图、
 * 兼容性闸门拦截与回退。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.js';
import { startUpstream } from '../src/upstream.js';

let gateway, base, pass = 0, fail = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    results.push(`  ✅ ${name}`);
    console.log(`  \x1b[32m✅\x1b[0m ${name}`);
  } catch (err) {
    fail++;
    results.push(`  ❌ ${name}\n     ${err.message}`);
    console.log(`  \x1b[31m❌\x1b[0m ${name}`);
    console.log(`     ${err.stack?.split('\n').slice(0, 3).join('\n     ')}`);
  }
}

async function call(method, p, body, headers = {}) {
  const opt = { method, headers: { ...headers } };
  if (body !== undefined) {
    opt.headers['content-type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(base + p, opt);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json, headers: r.headers };
}

const admin = {
  get: async (p) => (await fetch(base + p)).json(),
  post: async (p, body = {}) => {
    const r = await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    return { status: r.status, json };
  },
};

const validBody = () => ({ user: { name: 'alice', age: 25, role: 'member', ssn: '111-22-3333' }, internal: { debug: true, token: 't' } });

/** 简单 SSE 客户端：收集 N 条 event 后返回 */
async function collectSse(p, { waitMs = 1400 } = {}) {
  const r = await fetch(base + p);
  assert.equal(r.headers.get('content-type')?.includes('text/event-stream'), true);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', events = [];
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((res) => setTimeout(() => res({ done: true, timeout: true }), waitMs)),
    ]);
    if (chunk.done) break;
    if (chunk.timeout) break;
    buf += dec.decode(chunk.value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
      if (dataLine) events.push(JSON.parse(dataLine.slice(5).trim()));
    }
    if (events.length >= 3) break;
  }
  return { events, headers: r.headers };
}

async function main() {
  // 启动 mock 上游 + 网关（随机端口，避免冲突）
  const upstream = await startUpstream(0);
  const upPort = upstream.address().port;
  const app = createApp({ upstreamPort: upPort });
  gateway = app.server;
  gateway.listen(0);
  await once(gateway, 'listening');
  base = `http://127.0.0.1:${gateway.address().port}`;
  console.log(`\n▶ gateway on ${base}, upstream on ${upPort}\n`);

  // ---------- 1. 插件能力 ----------
  console.log('① 插件链基础能力');
  await test('字段移除：user.ssn 在转发前被删除', async () => {
    const r = await call('POST', '/echo', validBody());
    assert.equal(r.status, 200);
    // 协议转换在最后执行，body 已被包成 envelope，字段移除作用于 payload
    assert.equal(r.json.received.payload.user.ssn, undefined);
    assert.equal(r.json.received.payload.user.name, 'alice'); // 其余字段保留
  });

  await test('协议转换：body 被包成 envelope，带 _meta', async () => {
    const r = await call('POST', '/echo', validBody());
    assert.ok(r.json.received.payload, 'envelope.payload 存在');
    assert.equal(r.json.received._meta.chain, 'chain-a');
  });

  await test('本地规则校验：role=banned 被 422 短路，请求不到上游', async () => {
    const r = await call('POST', '/echo', { user: { name: 'x', role: 'banned' } });
    assert.equal(r.status, 422);
    assert.equal(r.json.error.code, 'validation_failed');
    assert.ok(r.json.error.violations.some((v) => v.rule === 'reject'));
    assert.equal(r.headers.get('x-gateway-chain'), 'chain-a'); // 拒绝也带链溯源
  });

  await test('必填校验：缺 user.name 返回 422', async () => {
    const r = await call('POST', '/echo', { user: { age: 20 } });
    assert.equal(r.status, 422);
    assert.ok(r.json.error.violations.some((v) => v.rule === 'required'));
  });

  await test('响应头带完整链溯源：chain/rev/mode/context/trace', async () => {
    const r = await call('POST', '/echo', validBody());
    assert.equal(r.headers.get('x-gateway-rev'), 'chain-a@r1');
    assert.equal(r.headers.get('x-gateway-mode'), 'atomic');
    assert.equal(r.headers.get('x-gateway-context'), 'v1');
    assert.equal(r.headers.get('x-gateway-trace'),
      'local-validation -> field-removal -> protocol-transform');
  });

  // ---------- 2. 已确认链约束 ----------
  console.log('\n② 已确认链状态机');
  await test('未确认链不能部署（draft 绝不接流量）', async () => {
    const r = await admin.post('/admin/deploy', { id: 'chain-c' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'chain_not_confirmed');
  });

  await test('保存草稿强制 confirmed=false 且 rev 自增', async () => {
    const r = await fetch(base + '/admin/chains', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'chain-tmp', contextVersion: 1,
        plugins: [{ plugin: 'field-removal', config: { remove: ['a'] } }],
      }),
    });
    const j = await r.json();
    assert.equal(j.chain.confirmed, false);
    assert.equal(j.chain.rev, 1);
  });

  // ---------- 3. 原子热切换 ----------
  console.log('\n③ 整条链原子热切换');
  await test('热切换 chain-a(v1) -> chain-b(v2) 后新请求命中新链', async () => {
    const r = await admin.post('/admin/deploy', { id: 'chain-b' });
    assert.equal(r.status, 200);
    assert.equal(r.json.active, 'chain-b@r1');
    const req = await call('POST', '/echo', validBody(), { 'x-scopes': 'write:users' });
    assert.equal(req.headers.get('x-gateway-rev'), 'chain-b@r1');
    assert.equal(req.headers.get('x-gateway-context'), 'v2');
    // v2 协议转换把 scopes 写进 _meta
    assert.deepEqual(req.json.received._meta.gatewayScopes, ['write:users']);
  });

  await test('新链规则生效：age=17 在 chain-b 下被 422（min:18）', async () => {
    const r = await call('POST', '/echo',
      { user: { name: 'u', age: 17, role: 'member' } }, { 'x-scopes': 'write:users' });
    assert.equal(r.status, 422);
    assert.ok(r.json.error.violations.some((v) => v.rule === 'min'));
  });

  await test('v2 scope 规则：缺 write:users 被 422', async () => {
    const r = await call('POST', '/echo',
      { user: { name: 'u', age: 20, role: 'member' } }); // 无 x-scopes
    assert.equal(r.status, 422);
    assert.ok(r.json.error.violations.some((v) => v.rule === 'scope'));
  });

  await test('热切换后 internal.token 也被移除（chain-b 更严格的字段移除）', async () => {
    const r = await call('POST', '/echo', validBody(), { 'x-scopes': 'write:users' });
    assert.equal(r.json.received.payload.internal?.token, undefined);
  });

  // ---------- 4. 流式请求钉住旧链 ----------
  console.log('\n④ SSE 流绑定不可变快照');
  await test('流进行中热切换：该流所有事件仍带旧链标识，字段按旧链移除', async () => {
    // 先回到 chain-a
    await admin.post('/admin/deploy', { id: 'chain-a' });
    const ssePromise = collectSse('/stream/users', { waitMs: 1200 });
    await new Promise((r) => setTimeout(r, 150)); // 等连接建立、首事件发出前切换
    await admin.post('/admin/deploy', { id: 'chain-b' });
    const { events, headers } = await ssePromise;
    assert.equal(events.length, 3, `期望 3 条事件，实际 ${events.length}: ${JSON.stringify(events).slice(0, 300)}`);
    // 流响应头是建立时的链
    assert.equal(headers.get('x-gateway-rev'), 'chain-a@r1');
    // 每条事件的 _gateway 都钉在旧链
    for (const ev of events) {
      assert.equal(ev._gateway.chain, 'chain-a@r1');
      assert.equal(ev._gateway.mode, 'atomic');
      // 旧链只移除 ssn，internal.debug 保留（新链才删 debug）
      assert.equal(ev.ssn, undefined);
      assert.notEqual(ev.internal?.debug, undefined);
    }
    // 而流外的新请求已是新链
    const after = await call('GET', '/users/9', undefined, { 'x-scopes': 'write:users' });
    assert.equal(after.headers.get('x-gateway-rev'), 'chain-b@r1');
    await admin.post('/admin/deploy', { id: 'chain-a' }); // 复位
  });

  // ---------- 5. 逐插件滚动替换 ----------
  console.log('\n⑤ 逐插件滚动替换（同版本同序列）');
  // 显式复位：滚动要求活动链是 v1 的 chain-a
  await admin.post('/admin/deploy', { id: 'chain-a' });

  await test('滚动启动：跨上下文版本被接流量前拦截', async () => {
    const r = await admin.post('/admin/rollout/start', { targetId: 'chain-b' }); // 当前 active=chain-a(v1)，b 是 v2
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'rolling_context_mismatch');
    const st = await admin.get('/admin/rollout');
    assert.equal(st.active, false); // 状态未被修改
    // 显式确保活动链仍为 chain-a，避免用例间状态残留
    const state = await admin.get('/admin/state');
    if (state.active !== 'chain-a@r1') await admin.post('/admin/deploy', { id: 'chain-a' });
  });

  await test('滚动 a -> a2：推进 1 个槽位后请求 trace 出现 B/T 混合', async () => {
    const start = await admin.post('/admin/rollout/start', { targetId: 'chain-a2' });
    assert.equal(start.status, 200,
      `rollout start failed: ${start.status} ${JSON.stringify(start.json).slice(0, 300)}`);
    await admin.post('/admin/rollout/advance', { slot: 0 });
    const r = await call('POST', '/echo',
      { user: { name: 'u', age: 15, role: 'member' } });
    assert.equal(r.headers.get('x-gateway-mode'), 'rolling');
    const trace = r.headers.get('x-gateway-trace');
    assert.match(trace, /T:local-validation/); // 槽位0 已是 target
    assert.match(trace, /B:field-removal/);    // 槽位1 还是 base
    // target 校验要求 age>=18，15 岁应被新槽位拦截
    assert.equal(r.status, 422);
  });

  await test('混合视图内部 ctx 版本一致（不会 v1/v2 插件同链）', async () => {
    const r = await call('POST', '/echo', validBody());
    assert.equal(r.headers.get('x-gateway-context'), 'v1');
  });

  await test('滚动回退：槽位全部退回 base，trace 恢复全 B', async () => {
    const r = await admin.post('/admin/rollout/rollback');
    assert.equal(r.status, 200);
    const req = await call('POST', '/echo', validBody());
    assert.equal(req.headers.get('x-gateway-mode'), 'atomic');
    assert.doesNotMatch(req.headers.get('x-gateway-trace'), /T:/);
  });

  await test('滚动全部槽位推进后自动 finalize，活动链原子提交为 target', async () => {
    await admin.post('/admin/rollout/start', { targetId: 'chain-a2' });
    for (let i = 0; i < 3; i++) await admin.post('/admin/rollout/advance', {});
    const st = await admin.get('/admin/state');
    assert.equal(st.active, 'chain-a2@r1');
    const r = await call('POST', '/echo', validBody());
    assert.equal(r.headers.get('x-gateway-mode'), 'atomic');
    // a2 的 field-removal 还删 internal.debug
    assert.equal(r.json.received.payload.internal?.debug, undefined);
    // 复位
    await admin.post('/admin/deploy', { id: 'chain-a' });
  });

  // ---------- 6. 兼容性闸门与回退 ----------
  console.log('\n⑥ 上下文版本兼容闸门 + 可验证回退');
  await test('chain-c(v2 + legacy-audit v1-only) confirm 被 409 拦截，附逐插件原因', async () => {
    const r = await admin.post('/admin/chains/chain-c/confirm');
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'context_incompatible');
    const p = r.json.error.details.problems;
    assert.equal(p.length, 1);
    assert.equal(p[0].plugin, 'legacy-audit');
    assert.deepEqual(p[0].supportedContextVersions, [1]);
    assert.equal(p[0].requiredContextVersion, 2);
  });

  await test('被拦后活动链照常服务（流量零影响）', async () => {
    const r = await call('POST', '/echo', validBody());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-gateway-rev'), 'chain-a@r1');
  });

  await test('回退路径：把 legacy-audit 放进 v1 链可通过闸门并部署', async () => {
    const save = await fetch(base + '/admin/chains', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'chain-c', contextVersion: 1, // 降回 v1
        description: '修复版：上下文降回 v1',
        plugins: [
          { plugin: 'local-validation', config: { required: ['user.name'] } },
          { plugin: 'legacy-audit', config: { tag: 'old-auditor' } },
          { plugin: 'field-removal', config: { remove: ['user.ssn'] } },
        ],
      }),
    });
    assert.equal(save.status, 201);
    const confirmed = await admin.post('/admin/chains/chain-c/confirm');
    assert.equal(confirmed.status, 200);
    const deployed = await admin.post('/admin/deploy', { id: 'chain-c' });
    assert.equal(deployed.status, 200);
    const r = await call('POST', '/echo', validBody());
    assert.equal(r.headers.get('x-gateway-context'), 'v1');
    // 管理面回退到上一条链
    const back = await admin.post('/admin/rollback', {});
    assert.equal(back.json.active, 'chain-a@r1');
  });

  await test('插件配置非法在构建期即报错（不产生半成品链）', async () => {
    const r = await fetch(base + '/admin/chains', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'chain-bad', contextVersion: 1,
        plugins: [{ plugin: 'field-removal', config: { remove: [] } }],
      }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error.code, 'plugin_config_error');
  });

  gateway.close();
  upstream.close();

  console.log(`\n────────────────────────────────`);
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试运行器异常:', err);
  process.exit(1);
});
