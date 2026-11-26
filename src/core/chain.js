import { deepFreeze } from './utils.js';
import { GatewayError } from './errors.js';
import { pluginSupportsContext } from './context.js';

/**
 * 链快照：一条已确认过滤链的不可变快照。
 *
 * 不可变性是整个热切换安全模型的根基：
 * - 请求进入时拿到 view（原子快照或滚动视图），整条请求（含 SSE 长连接）只持有这个引用；
 * - 配置切换只替换 store 内的指针，旧请求引用的旧对象不会被任何人原地修改；
 * - 因此流式请求天然继续使用旧链，而新请求只能看到新指针，不可能误用旧规则。
 */
export class ChainSnapshot {
  constructor(def, pluginRegistry) {
    if (!def.id || typeof def.id !== 'string') {
      throw new GatewayError(400, 'invalid_chain', 'chain id is required');
    }
    if (!Array.isArray(def.plugins) || def.plugins.length === 0) {
      throw new GatewayError(400, 'invalid_chain', `chain ${def.id} must contain at least one plugin`);
    }

    this.id = def.id;
    this.rev = def.rev ?? 1;
    this.revLabel = `${def.id}@r${this.rev}`;
    this.description = def.description ?? '';
    this.contextVersion = def.contextVersion ?? 1;
    this.confirmed = def.confirmed === true;
    this.createdAt = def.createdAt ?? new Date().toISOString();

    this.plugins = def.plugins.map((step, index) => {
      const factory = pluginRegistry[step.plugin];
      if (!factory) {
        throw new GatewayError(400, 'unknown_plugin', `chain ${this.id} references unknown plugin "${step.plugin}"`);
      }
      let instance;
      try {
        instance = factory(step.config ?? {});
      } catch (err) {
        throw new GatewayError(400, 'plugin_config_error',
          `plugin "${step.plugin}" in chain ${this.id} rejected its config: ${err.message}`);
      }
      return Object.freeze({
        slot: index,
        pluginId: step.plugin,
        config: deepFreeze(structuredClone(step.config ?? {})),
        instance: Object.freeze(instance),
      });
    });

    deepFreeze(this);
  }

  get mode() {
    return 'atomic';
  }

  /** 原子链在所有阶段都返回同一份不可变插件步骤。 */
  stageAt(_slot) {
    return this.plugins[_slot];
  }

  /** 部署/确认前的兼容性闸门：任何插件不支持本链的上下文版本，立即拒绝（接流量之前）。 */
  preflight() {
    const problems = [];
    for (const step of this.plugins) {
      if (!pluginSupportsContext(step.instance, this.contextVersion)) {
        problems.push({
          plugin: step.pluginId,
          slot: step.slot,
          supportedContextVersions: step.instance.supportedContextVersions,
          requiredContextVersion: this.contextVersion,
        });
      }
    }
    if (problems.length > 0) {
      const err = new GatewayError(409, 'context_incompatible',
        `chain ${this.revLabel} cannot be confirmed: plugin/context version mismatch`, { problems });
      err.problems = problems;
      throw err;
    }
    return { ok: true, checks: this.plugins.map((s) => ({ slot: s.slot, plugin: s.pluginId, ok: true })) };
  }

  describe() {
    return {
      id: this.id,
      rev: this.rev,
      revLabel: this.revLabel,
      description: this.description,
      contextVersion: this.contextVersion,
      confirmed: this.confirmed,
      createdAt: this.createdAt,
      plugins: this.plugins.map((s) => ({ slot: s.slot, plugin: s.pluginId, config: s.config })),
    };
  }
}

/**
 * 滚动视图：逐插件替换期间的"混合视图"。
 * 每个槽位指向 base 或 target 的插件步骤；视图本身冻结后同样可被整条请求安全持有。
 * 注意：滚动只允许同上下文版本、同插件序列（见 RollingRollout），
 * 因此混合视图内部不存在上下文版本错配 —— 跨版本升级必须走原子热切换。
 */
export class RollingView {
  constructor(base, target, slots, rolloutId) {
    this.chainId = target.id;
    this.revLabel = `${target.id}@r${target.rev}#rollout-${rolloutId}`;
    this.contextVersion = target.contextVersion;
    this.mode = 'rolling';
    this.base = base;
    this.target = target;
    this.steps = Object.freeze(base.plugins.map((b, slot) => Object.freeze({
      slot,
      source: slots[slot] ? 'target' : 'base',
      step: slots[slot] ? target.plugins[slot] : b,
    })));
    this.frozenSlots = Object.freeze([...slots]);
    Object.freeze(this);
  }

  stageAt(slot) {
    return this.steps[slot].step;
  }

  /** 流水线统一通过 view.plugins 遍历；滚动视图下即各槽位当前生效的步骤。 */
  get plugins() {
    return this.steps.map((s) => s.step);
  }

  describeTrace() {
    return this.steps.map((s) => `${s.source === 'target' ? 'T' : 'B'}:${s.step.pluginId}`);
  }
}
