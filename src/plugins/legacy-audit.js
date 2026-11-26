/**
 * 遗留审计插件（legacy-audit）
 *
 * 演示用"不支持新版上下文"的插件：只声明 supportedContextVersions: [1]。
 * 把它放进 contextVersion:2 的链时，confirm 阶段的兼容性闸门会拒绝整条链，
 * 流量永远到不了一个 v1-only 插件手里。
 *
 * 可验证的回退路径：
 *   1) 闸门返回 409 + 每个不兼容插件的具体原因；
 *   2) 链保持 draft，活动链不受影响；
 *   3) POST /admin/chains/:id/rollback 或重新确认一条兼容链即可恢复。
 */
export function createLegacyAudit(config) {
  const tag = config.tag ?? 'legacy';
  return {
    id: 'legacy-audit',
    kind: 'request',
    supportedContextVersions: [1], // 刻意只支持 v1
    config: { tag },

    async onRequest(ctx) {
      ctx.meta.legacyAudit = {
        tag,
        principal: ctx.auth.principal,
        at: new Date().toISOString(),
      };
      return ctx;
    },
  };
}
