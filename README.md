# Pointwise 本地 API 网关（零依赖，Node.js）

一个从零搭建的本地插件化 API 网关，核心是**不可变过滤链快照**驱动的热切换安全模型，
带一个可试发请求、可对比切换策略、可演示兼容闸门的调试页。

## 运行

```bash
node src/server.js          # 网关+管理面 :8080，mock 上游 :9001
# 打开调试页：http://127.0.0.1:8080/
node test/run-tests.mjs     # 21 项端到端测试
```

无第三方依赖，Node >= 18（开发环境 v24）。端口可用 `PORT` / `UPSTREAM_PORT` 覆盖。

## 目录结构

```
src/
  core/
    context.js        网关上下文 v1/v2 契约 + 插件版本匹配
    chain.js          ChainSnapshot（不可变链快照）/ RollingView（滚动混合视图）
    store.js          链状态机：draft → confirmed → active，活动指针 + 回退
    rollout.js        逐插件滚动替换控制器（同版本/同序列强制约束）
    errors.js         GatewayError / ValidationRejection
    utils.js          冻结、dotted-path、JSON body、SSE 工具
  plugins/
    field-removal.js       字段移除（请求 + SSE 事件两阶段）
    protocol-transform.js  协议转换（envelope/flat，v2 注入 scopes）
    local-validation.js    本地规则校验（required/type/min/max/enum/reject/scope）
    legacy-audit.js        只支持 ctx v1 的遗留插件（兼容闸门演示）
  config/chains.js   四条预置链
  gateway.js         数据面流水线（链绑定点 + SSE 透传）
  admin.js           管理面 REST API
  upstream.js        mock 上游（/echo /users /stream/users SSE）
  server.js          组装入口
public/              调试页（原生 HTML/JS）
test/run-tests.mjs   端到端测试
```

## 需求 → 实现对照

### 1. 插件过滤链：字段移除、协议转换、本地规则校验
每个插件实现 `onRequest`（请求阶段）和/或 `onSseEvent`（流事件阶段），
声明 `kind` 与 `supportedContextVersions`。链按槽位顺序执行，校验失败抛
`ValidationRejection` 短路为 422，请求不触达上游。

### 2. 一条请求的多个插件必须来自同一条已确认的链
- 链有状态机：`draft`（保存即草稿，**绝不接流量**）→ `confirm()` 跑兼容性闸门 →
  `confirmed` → `deploy()` 才能成为活动链。部署未确认链直接 409 `chain_not_confirmed`。
- 请求入口解析出一个 view（`ChainSnapshot` 或 `RollingView`），整条请求只通过
  `view.stageAt(slot)` 取插件，不存在跨链拼接的可能。

### 3. 配置切换：流式请求用旧链，新请求不用旧规则
`ChainSnapshot` 递归冻结，切换只做一次活动指针赋值（Node 单线程内原子）。
进行中的 SSE 连接在入口已持有旧 view 引用，切换不改变该对象；新请求解析到新指针。
每条 SSE 事件注入 `_gateway.chain` 作为链绑定证据，响应头带
`x-gateway-chain/rev/mode/context/trace/request-id`。测试④在流建立后热切换，
断言三条事件全部钉在旧链、按旧规则移除字段，而流外新请求已是新链。

### 4. 调试页对比：整条链热切换 vs 逐插件替换
`http://127.0.0.1:8080/`，三个工作区：
- **① 试发请求**：方法/路径/头/JSON body，展示状态码、链溯源头与 trace；可开 SSE 流；
- **② 切换对比**：
  - 热切换（原子）：一次指针翻转，每请求完整一条链，允许跨 ctx 版本；
    「并发对比演示」切换窗口连发 12 请求，trace 要么全旧要么全新；
  - 逐插件滚动：槽位逐个推进，混合期请求的 trace 出现 `B:`/`T:` 前缀，
    可单步推进观察、可回退；跨版本或插件序列不一致时**启动前 409 拦截**。
- **③ 兼容闸门**：一键确认含 v1-only 插件的 v2 链，观察 409 与逐插件原因。

### 5. 插件不支持新版上下文：接流量前拦截 + 可验证回退
- 上下文是版本化契约：v1 = request/meta/auth.principal；v2 增加 auth.scopes、features。
- `ChainSnapshot.preflight()` 逐插件核对 `supportedContextVersions`，在 `confirm` 阶段
  （而非请求阶段）抛 409 `context_incompatible`，附每个不兼容插件的槽位/支持版本/要求版本。
- 被拦链保持 draft，活动链与在途流量零影响（测试⑥有断言）。
- 回退路径（均可验证）：
  1. `POST /admin/rollback` 回到上一条活动链（响应含 from/to 记录）；
  2. 改链（移除问题插件或降回 ctx v1）→ 重新 confirm → deploy（测试⑥走通完整路径）；
  3. 滚动场景有独立的 `POST /admin/rollout/rollback`，槽位全部退回 base，活动指针不变。

## 管理面 API 速览

| 方法/路径 | 作用 |
| --- | --- |
| GET `/admin/state` | 活动链、全部链、历史、滚动状态 |
| GET `/admin/plugins` | 插件注册表与上下文版本声明 |
| PUT `/admin/chains` | 保存草稿（rev 自增、强制未确认） |
| POST `/admin/chains/:id/confirm` | 兼容性闸门 + 确认 |
| POST `/admin/deploy` `{id}` | 原子热切换 |
| POST `/admin/rollback` `{targetId?}` | 回退（缺省回上一条） |
| POST `/admin/rollout/start` `{targetId}` | 启动滚动（接流量前约束检查） |
| POST `/admin/rollout/advance` `{slot?}` | 推进槽位；全部推进后自动 finalize |
| POST `/admin/rollout/rollback` | 滚动回退 |
| GET `/admin/events` | 变更 SSE 推送（调试页自动刷新） |

## 预置链

| 链 | ctx | 用途 |
| --- | --- | --- |
| chain-a（初始 active） | v1 | 宽松校验 + 移除 ssn |
| chain-a2 | v1 | 同插件序列、收紧规则 —— 滚动演示目标 |
| chain-b | v2 | scope 校验 + 更严格字段移除 —— 原子热切换目标 |
| chain-c（draft） | v2 | 含 v1-only 的 legacy-audit —— 确认必被闸门拦截 |
