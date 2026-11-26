/**
 * 协议转换插件（protocol-transform）
 *
 * config: { mode: "envelope" | "flat" }
 *  - envelope: 裸 JSON -> { payload, _meta:{...} }
 *  - flat:     { payload, _meta } -> payload（反向转换）
 *
 * v2 上下文下额外把 auth.scopes 写入 _meta.gatewayScopes，用于体现上下文版本差异。
 */
export function createProtocolTransform(config) {
  const mode = config.mode ?? 'envelope';
  if (!['envelope', 'flat'].includes(mode)) {
    throw new Error(`protocol-transform: unknown mode "${mode}"`);
  }

  return {
    id: 'protocol-transform',
    kind: 'both',
    supportedContextVersions: [1, 2],
    config: { mode },

    async onRequest(ctx) {
      const body = ctx.request.body;
      if (!body || typeof body !== 'object') return ctx;

      if (mode === 'envelope') {
        const _meta = {
          transformedAt: new Date().toISOString(),
          chain: ctx.meta.chainId,
          requestId: ctx.requestId,
        };
        if (ctx.version >= 2) _meta.gatewayScopes = ctx.auth.scopes;
        ctx.request.body = { payload: structuredClone(body), _meta };
      } else if (mode === 'flat' && body.payload && body._meta) {
        ctx.request.body = structuredClone(body.payload);
      }
      ctx.meta.protocolMode = mode;
      return ctx;
    },

    async onSseEvent(ctx, event) {
      if (!event.data || typeof event.data !== 'object') return event;
      if (mode === 'envelope') {
        const _meta = { eventId: event.id, chain: ctx.meta.chainId };
        if (ctx.version >= 2) _meta.gatewayScopes = ctx.auth.scopes;
        event.data = { payload: structuredClone(event.data), _meta };
      } else if (mode === 'flat' && event.data.payload) {
        event.data = structuredClone(event.data.payload);
      }
      return event;
    },
  };
}
