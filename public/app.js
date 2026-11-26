/* 调试台前/后台交互（纯 vanilla JS，无依赖） */
const $ = (id) => document.getElementById(id);
let state = null;
let evtSource = null;
let sseSource = null;

function toast(msg, ok = true) {
  const box = $('toast');
  const el = document.createElement('div');
  el.className = `item ${ok ? 'ok' : 'err'}`;
  el.innerHTML = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

async function api(method, p, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['content-type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(p, opt);
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(json?.error?.message || `${r.status}`);
    err.payload = json;
    err.status = r.status;
    throw err;
  }
  return json;
}

/* ---------- 状态渲染 ---------- */
async function loadState() {
  state = await api('GET', '/admin/state');
  const active = state.activeChain;
  $('activeBadge').textContent = `active: ${state.active ?? 'none'}`;
  $('modeBadge').textContent = `mode: ${state.rollout?.active ? 'rolling' : 'atomic'}`;

  $('chainList').innerHTML = state.chains.map((c) => {
    const isActive = state.active === c.revLabel;
    const incompat = c.id === 'chain-c' && !c.confirmed;
    return `
    <div class="chain-card ${isActive ? 'active' : ''} ${c.confirmed ? '' : 'draft'}">
      <div class="chain-head">
        <span class="chain-name">${c.revLabel}</span>
        <span>
          <span class="tag v${c.contextVersion}">ctx v${c.contextVersion}</span>
          ${isActive ? '<span class="tag active">active</span>'
            : c.confirmed ? '<span class="tag confirmed">confirmed</span>'
            : (incompat ? '<span class="tag incompat">blocked/draft</span>' : '<span class="tag draft">draft</span>')}
        </span>
      </div>
      <div class="chain-desc">${c.description ?? ''}</div>
      ${c.plugins.map((p) => `<div class="plugin-line">#${p.slot} ${p.plugin} ${esc(JSON.stringify(p.config))}</div>`).join('')}
      <div class="row">
        ${!c.confirmed ? `<button class="danger" onclick="confirmChain('${c.id}')">确认(过闸门)</button>` : ''}
        ${c.confirmed && !isActive ? `<button class="good" onclick="hotDeploy('${c.id}')">热切换</button>` : ''}
      </div>
    </div>`;
  }).join('');

  const plugins = await api('GET', '/admin/plugins');
  $('pluginList').innerHTML = plugins.plugins.map((p) => `
    <div class="plugin-line">${p.id} · kind=${p.kind} · supports ctx: [${p.supportedContextVersions.join(',')}]</div>
  `).join('');

  renderRollout();
}

function renderRollout() {
  const r = state.rollout;
  if (!r.active) {
    $('rollStatus').innerHTML = '<p class="small">无进行中的滚动。</p>';
    return;
  }
  $('rollStatus').innerHTML = `
    <div class="small">rollout ${esc(r.id)}：${esc(r.base)} → ${esc(r.target)}（${r.advancedCount}/${r.totalSlots} 槽位已切换）</div>
    <div class="slotbar">
      ${r.slots.map((s) => `<div class="slot ${s.source}">#${s.slot}<br>${s.source}:${esc(s.plugin)}</div>`).join('')}
    </div>`;
}

/* ---------- ① 试发请求 ---------- */
function parseHdrs(text) {
  const out = {};
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

async function sendRequest() {
  const method = $('m').value;
  const p = $('path').value;
  const hdrs = parseHdrs($('hdrs').value);
  const opts = { method, headers: hdrs };
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    try { JSON.parse($('body').value); } catch { toast('body 不是合法 JSON', false); return; }
    opts.body = $('body').value;
  }
  const t0 = performance.now();
  let resp, text, status;
  try {
    resp = await fetch(p, opts);
    text = await resp.text();
    status = resp.status;
  } catch (e) {
    toast('请求失败: ' + e.message, false);
    return;
  }
  const ms = Math.round(performance.now() - t0);
  const h = resp.headers;
  $('respMeta').innerHTML = `
    <div class="kv">
      <div class="k">status</div><div class="status-${String(status)[0]}xx">${status} (${ms}ms)</div>
      <div class="k">chain</div><div>${esc(h.get('x-gateway-chain') ?? '-')} / ${esc(h.get('x-gateway-rev') ?? '-')}</div>
      <div class="k">mode</div><div>${esc(h.get('x-gateway-mode') ?? '-')} · ctx ${esc(h.get('x-gateway-context') ?? '-')}</div>
      <div class="k">trace</div><div class="trace">${formatTrace(h.get('x-gateway-trace') ?? '')}</div>
    </div>`;
  const out = $('respOut');
  out.classList.remove('hidden');
  try { out.textContent = JSON.stringify(JSON.parse(text), null, 2); }
  catch { out.textContent = text; }
}

function formatTrace(t) {
  return esc(t).replace(/B:/g, '<span class="B">B:</span>').replace(/T:/g, '<span class="T">T:</span>');
}

/* ---------- SSE 流（验证流内钉住旧链） ---------- */
function openSse() {
  closeSse();
  $('sseBox').innerHTML = '<p class="small">流已打开，事件将逐条经过链上响应插件…（现在去切换链试试）</p>';
  sseSource = new EventSource($('path').value.startsWith('/stream') ? $('path').value : '/stream/users');
  sseSource.addEventListener('user', (ev) => {
    const data = JSON.parse(ev.data);
    const box = $('sseBox');
    const el = document.createElement('div');
    el.className = 'sse-event';
    el.innerHTML = `<span class="small">event id=${esc(ev.lastEventId)}</span><br>${esc(JSON.stringify(data, null, 2))}`;
    box.appendChild(el);
  });
  sseSource.onerror = () => { /* 服务端正常关闭也会触发 */ };
  toast('SSE 流已建立');
}
function closeSse() { if (sseSource) { sseSource.close(); sseSource = null; } }

/* ---------- ② 热切换 / 滚动 ---------- */
async function hotDeploy(id) {
  try {
    const r = await api('POST', '/admin/deploy', { id, reason: 'debug page hot-swap' });
    toast(`热切换完成：${esc(r.previous ?? '∅')} → <b>${esc(r.active)}</b>`);
    await loadState();
  } catch (e) { toast('热切换被拒: ' + e.message, false); }
}
async function rollback() {
  try {
    const r = await api('POST', '/admin/rollback', {});
    toast(`已回退：当前 <b>${esc(r.active)}</b>`);
    await loadState();
  } catch (e) { toast('回退失败: ' + e.message, false); }
}
async function rollStart(targetId) {
  try {
    const r = await api('POST', '/admin/rollout/start', { targetId });
    toast(`滚动已开始：${esc(r.rollout.target.revLabel)}`);
    await loadState();
  } catch (e) {
    toast(`滚动被闸门拦截（接流量前）：${e.message}`, false);
    if (e.payload?.error?.details) {
      $('gateOut').innerHTML = gateHtml(e.payload.error, true);
    }
  }
}
async function rollAdvance() {
  try { await api('POST', '/admin/rollout/advance', {}); await loadState(); }
  catch (e) { toast(e.message, false); }
}
async function rollRollback() {
  try { const r = await api('POST', '/admin/rollout/rollback', {}); toast('滚动已回退，活动链: ' + esc(r.active)); await loadState(); }
  catch (e) { toast(e.message, false); }
}

/* ---------- ③ 兼容闸门 ---------- */
async function confirmChain(id) {
  try {
    const r = await api('POST', `/admin/chains/${id}/confirm`);
    toast(`链 ${esc(r.chain.revLabel)} 通过闸门并确认`, true);
    $('gateOut').innerHTML = `<div class="gate-note ok">✅ preflight 通过：${r.chain.plugins.length} 个插件全部兼容 ctx v${r.chain.contextVersion}，可以接流量。</div>`;
    await loadState();
  } catch (e) {
    toast(`兼容性闸门拦截了 ${id}（活动链未受影响）`, false);
    $('gateOut').innerHTML = gateHtml(e.payload.error, false);
  }
}

function gateHtml(err, warning) {
  const problems = err?.details?.problems ?? [];
  return `
  <div class="gate-note">
    <b>⛔ ${esc(err.code)} — ${esc(err.message)}</b>
    ${problems.map((p) => `
      <div style="margin-top:8px">
        <div>插件 <code class="inline">${esc(p.plugin)}</code>（槽位 ${p.slot}）只支持 ctx [${p.supportedContextVersions.join(',')}]，
        链要求 ctx v${p.requiredContextVersion}</div>
      </div>`).join('')}
    <div class="small" style="margin-top:8px">
      可验证的回退：① 链保持 draft，活动链不变；② 改链移除该插件或降回 ctx v1 后重新确认；
      ③ 或 <code class="inline">POST /admin/rollback</code> 回到上一条已确认链。
    </div>
  </div>`;
}

/* ---------- 并发对比演示 ---------- */
async function raceDemo(kind) {
  const N = 12;
  // 实时读取活动链，避免依赖可能过期的本地 state
  const fresh = await api('GET', '/admin/state');
  const target = kind === 'hot'
    ? (fresh.activeChain?.id === 'chain-b' ? 'chain-a' : 'chain-b')
    : 'chain-a2';
  const jobs = [];

  if (kind === 'rolling') {
    try { await api('POST', '/admin/rollout/start', { targetId: target }); }
    catch (e) { toast('滚动启动失败: ' + e.message, false); return; }
  }

  // 先发 3 个请求，然后切换/推进，再发剩下的 —— 制造切换窗口内的并发
  const sendOne = (i) => fetch('/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-scopes': 'write:users' },
    body: JSON.stringify({ user: { name: 'u' + i, age: 17, role: i % 2 ? 'guest' : 'member', ssn: 'x' } }),
  }).then(async (r) => ({
    i, status: r.status,
    chain: r.headers.get('x-gateway-rev'),
    mode: r.headers.get('x-gateway-mode'),
    trace: r.headers.get('x-gateway-trace'),
    body: await r.json(),
  })).catch((e) => ({ i, error: e.message }));

  for (let i = 0; i < 3; i++) jobs.push(sendOne(i));
  await new Promise((r) => setTimeout(r, 50));

  let switchPromise;
  if (kind === 'hot') {
    switchPromise = api('POST', '/admin/deploy', { id: target, reason: 'race demo' }).catch((e) => e);
  } else {
    // 滚动：依次推进槽位，与剩余请求并发
    switchPromise = (async () => {
      await api('POST', '/admin/rollout/advance', {});
      await new Promise((r) => setTimeout(r, 80));
      await api('POST', '/admin/rollout/advance', {});
      await new Promise((r) => setTimeout(r, 80));
      await api('POST', '/admin/rollout/advance', {});
    })().catch((e) => e);
  }

  for (let i = 3; i < N; i++) jobs.push(sendOne(i));
  const results = await Promise.all(jobs);
  await switchPromise;
  await loadState();

  const rows = results.sort((a, b) => a.i - b.i).map((r) => `
    <tr>
      <td>#${r.i}</td>
      <td class="status-${String(r.status)[0]}xx">${r.status}</td>
      <td>${esc(r.chain ?? '-')}</td>
      <td>${esc(r.mode ?? '-')}</td>
      <td class="trace" style="margin:0">${formatTrace(r.trace ?? '-')}</td>
      <td>${r.status === 422 ? esc((r.body.error.violations || []).map((v) => v.rule).join(',')) : '通过'}</td>
    </tr>`).join('');

  $('raceOut').innerHTML = `
    <h2 style="margin-top:14px">🏁 ${kind === 'hot' ? '原子热切换' : '逐插件滚动'} 并发结果（${N} 请求）</h2>
    <table class="compare-table">
      <tr><th>#</th><th>状态</th><th>命中链</th><th>模式</th><th>trace</th><th>校验</th></tr>
      ${rows}
    </table>
    <p class="small">
      ${kind === 'hot'
        ? '观察：每条请求的 trace 都是<b>完整一条链</b>（全 a 或全 b），不存在跨链拼接；422 的差异来自两条链规则不同。'
        : '观察：滚动窗口内 trace 出现 B:/T: <b>混合前缀</b>，但每个请求的 ctx 版本始终一致；finalize 后全部变 T。'}
    </p>`;
}

/* ---------- tabs / events ---------- */
function switchTab(t) {
  $('tabHot').classList.toggle('on', t === 'hot');
  $('tabRoll').classList.toggle('on', t === 'roll');
  $('paneHot').classList.toggle('hidden', t !== 'hot');
  $('paneRoll').classList.toggle('hidden', t !== 'roll');
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function connectEvents() {
  evtSource = new EventSource('/admin/events');
  evtSource.onopen = () => { $('sconn').textContent = 'events: live'; };
  evtSource.onmessage = () => loadState();
  evtSource.onerror = () => { $('sconn').textContent = 'events: reconnecting…'; };
}

loadState();
connectEvents();
