/**
 * 字段移除插件（field-removal）
 *
 * config: { remove: string[] }   dotted path 列表，如 ["user.ssn", "internal.debug"]
 *
 * 请求阶段从 JSON body 删除字段；SSE 流阶段对每个 event 的 data 做同样删除 ——
 * 长连接每一条事件都走同一插件实例、同一配置（链快照保证）。
 *
 * 路径匹配策略：先按精确 dotted path 删除；若事件数据是扁平形态（没有 user 包裹层），
 * 回退按叶字段名删除（"user.ssn" -> "ssn"），两种数据形态都能覆盖。
 */
import { deletePath } from '../core/utils.js';

function removeFlexible(target, dotted) {
  if (deletePath(target, dotted)) return true;
  const leaf = dotted.split('.').at(-1);
  if (leaf !== dotted) return deletePath(target, leaf);
  return false;
}

export function createFieldRemoval(config) {
  if (!Array.isArray(config.remove) || config.remove.length === 0) {
    throw new Error('field-removal requires config.remove: string[]');
  }
  const paths = config.remove;

  return {
    id: 'field-removal',
    kind: 'both',
    supportedContextVersions: [1, 2],
    config,

    async onRequest(ctx) {
      if (ctx.request.body && typeof ctx.request.body === 'object') {
        const removed = [];
        for (const p of paths) {
          if (removeFlexible(ctx.request.body, p)) removed.push(p);
        }
        ctx.meta.fieldRemoval = { removed };
      }
      return ctx;
    },

    async onSseEvent(ctx, event) {
      if (event.data && typeof event.data === 'object') {
        for (const p of paths) removeFlexible(event.data, p);
      }
      return event;
    },
  };
}
