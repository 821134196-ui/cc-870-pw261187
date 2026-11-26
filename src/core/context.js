/**
 * 网关上下文（Gateway Context）
 *
 * 上下文是有版本的契约：
 * - v1: request / meta / auth.principal
 * - v2: 在 v1 基础上增加 auth.scopes 与 features（结构化新增字段，不向后兼容 v1-only 插件）
 *
 * 插件通过 supportedContextVersions 声明自己能处理哪些版本；
 * 链在 confirm 时由兼容性闸门逐插件检查，不匹配则在接流量之前拒绝。
 */
let requestSeq = 0;

export function createContext({ view, method, path, headers, query, body }) {
  const ctx = {
    version: view.contextVersion,
    requestId: `req_${++requestSeq}_${Date.now().toString(36)}`,
    request: { method, path, headers, query, body },
    meta: {
      chainId: view.chainId ?? view.id,
      revLabel: view.revLabel,
      mode: view.mode,
      startedAt: new Date().toISOString(),
    },
    auth: {
      principal: headers['x-user'] ?? 'anonymous',
    },
  };

  if (view.contextVersion >= 2) {
    ctx.auth.scopes = (headers['x-scopes'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    ctx.features = new Set();
  }

  return ctx;
}

export function pluginSupportsContext(plugin, contextVersion) {
  return plugin.supportedContextVersions.includes(contextVersion);
}
