import { ValidationRejection } from '../core/errors.js';
import { getPath } from '../core/utils.js';

/**
 * 本地规则校验插件（local-validation）
 *
 * config:
 * {
 *   required: string[],                       // 必须存在且非空
 *   rules: [{ field, type?: "number"|"string"|"boolean", min?, max?, enum?: any[], reject?: any[] }]
 * }
 *
 * 校验失败时抛出 ValidationRejection，由流水线短路为 422（请求不会被转发到上游）。
 * v2 规则可声明 scopeRequired —— 仅在 v2 上下文生效，演示上下文版本带来的能力差异。
 */
export function createLocalValidation(config) {
  const required = config.required ?? [];
  const rules = config.rules ?? [];
  if (!Array.isArray(required) || !Array.isArray(rules)) {
    throw new Error('local-validation requires arrays for required/rules');
  }

  return {
    id: 'local-validation',
    kind: 'request',
    supportedContextVersions: [1, 2],
    config,

    async onRequest(ctx) {
      // 只读请求（GET/HEAD 等）无 body，本地 body 规则不适用 —— 直接放行。
      if (!['POST', 'PUT', 'PATCH'].includes(ctx.request.method)) return ctx;

      const body = ctx.request.body;
      const violations = [];

      for (const field of required) {
        const v = getPath(body, field);
        if (v === undefined || v === null || v === '') {
          violations.push({ field, rule: 'required', message: `${field} is required` });
        }
      }

      for (const rule of rules) {
        if (rule.scopeRequired && ctx.version < 2) continue; // v2-only 规则
        if (rule.scopeRequired && !ctx.auth.scopes.includes(rule.scopeRequired)) {
          violations.push({ field: rule.field, rule: 'scope', message: `requires scope ${rule.scopeRequired}` });
          continue;
        }
        const v = getPath(body, rule.field);
        if (v === undefined || v === null) continue; // 缺失由 required 负责

        if (rule.type && typeof v !== rule.type) {
          violations.push({ field: rule.field, rule: 'type', message: `${rule.field} must be ${rule.type}, got ${typeof v}` });
          continue;
        }
        if (rule.type === 'number') {
          if (rule.min !== undefined && v < rule.min) {
            violations.push({ field: rule.field, rule: 'min', message: `${rule.field} must be >= ${rule.min}` });
          }
          if (rule.max !== undefined && v > rule.max) {
            violations.push({ field: rule.field, rule: 'max', message: `${rule.field} must be <= ${rule.max}` });
          }
        }
        if (Array.isArray(rule.enum) && !rule.enum.includes(v)) {
          violations.push({ field: rule.field, rule: 'enum', message: `${rule.field} must be one of ${rule.enum.join(', ')}` });
        }
        if (Array.isArray(rule.reject) && rule.reject.includes(v)) {
          violations.push({ field: rule.field, rule: 'reject', message: `${rule.field}=${JSON.stringify(v)} is explicitly rejected` });
        }
      }

      if (violations.length > 0) {
        throw new ValidationRejection(violations, ctx.meta.chainId);
      }
      return ctx;
    },
  };
}
