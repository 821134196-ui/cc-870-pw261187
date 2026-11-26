import { EventEmitter } from 'node:events';
import { RollingView } from './chain.js';
import { GatewayError } from './errors.js';
import { nowIso } from './utils.js';

/**
 * RollingRollout —— 逐插件替换（滚动发布）控制器。
 *
 * 与原子热切换的本质差异：
 *  - hot-atomic：一次指针翻转，每个请求要么整条旧链、要么整条新链，绝不混合；
 *  - rolling：槽位逐个推进，推进窗口内的请求拿到 RollingView（部分 base、部分 target），
 *    X-Gateway-Trace 里会同时出现 B: / T: 前缀，混合期可直接观测。
 *
 * 安全约束（启动滚动前强制检查，接流量之前拦截）：
 *  1. base 与 target 必须同上下文版本 —— 否则混合视图里 v1/v2 插件共存在同一请求；
 *  2. 插件序列（id 顺序）必须一致 —— 逐槽位替换要求槽位语义对齐；
 *  3. target 必须已确认（preflight 已过）。
 * 不满足时返回 409 并提示改用原子热切换，且不修改任何状态。
 */
export class RollingRollout extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.rollout = null; // { id, base, target, slots:boolean[], startedAt, events }
    this.history = [];
  }

  isActive() {
    return this.rollout !== null;
  }

  /** 网关每请求调用：滚动进行中返回 RollingView，否则返回 null（走 store 的原子活动链）。 */
  currentView() {
    if (!this.rollout) return null;
    return new RollingView(
      this.rollout.base,
      this.rollout.target,
      this.rollout.slots,
      this.rollout.id,
    );
  }

  start(targetId) {
    if (this.rollout) {
      throw new GatewayError(409, 'rollout_in_progress',
        `rollout ${this.rollout.id} still in progress — finalize or rollback first`);
    }
    const base = this.store.active();
    if (!base) throw new GatewayError(409, 'no_active_chain', 'set an active chain before rolling');
    const target = this.store.get(targetId);
    if (base.id === target.id) {
      throw new GatewayError(409, 'rollout_same_chain',
        `target "${targetId}" is already the active chain; pick a different chain`);
    }
    if (!target.confirmed) {
      throw new GatewayError(409, 'chain_not_confirmed',
        `rolling target "${targetId}" must be confirmed before traffic`);
    }
    if (base.contextVersion !== target.contextVersion) {
      throw new GatewayError(409, 'rolling_context_mismatch',
        `rolling requires identical context versions (base=v${base.contextVersion}, target=v${target.contextVersion}); ` +
        'cross-version replacement must use atomic hot-swap (POST /admin/deploy)',
        { baseContext: base.contextVersion, targetContext: target.contextVersion });
    }
    const baseIds = base.plugins.map((p) => p.pluginId);
    const targetIds = target.plugins.map((p) => p.pluginId);
    if (baseIds.length !== targetIds.length || baseIds.some((id, i) => id !== targetIds[i])) {
      throw new GatewayError(409, 'rolling_shape_mismatch',
        'rolling requires identical plugin sequence slot-by-slot; use atomic hot-swap for structural changes',
        { base: baseIds, target: targetIds });
    }

    const id = `rol_${Date.now().toString(36)}`;
    this.rollout = {
      id,
      base,
      target,
      slots: base.plugins.map(() => false),
      startedAt: nowIso(),
      events: [{ at: nowIso(), type: 'started' }],
    };
    this.emit('changed', { type: 'rollout_started', id, target: target.revLabel });
    return this.status();
  }

  /** 推进单个槽位（或下一个未推进槽位）。 */
  advance(slot = null) {
    if (!this.rollout) throw new GatewayError(409, 'no_rollout', 'no rollout in progress');
    const { slots, target } = this.rollout;
    let idx = slot;
    if (idx === null) idx = slots.findIndex((s) => !s);
    if (idx < 0 || idx >= slots.length) {
      throw new GatewayError(400, 'bad_slot', `slot ${slot} out of range (0..${slots.length - 1})`);
    }
    if (slots[idx]) throw new GatewayError(409, 'slot_advanced', `slot ${idx} already on target`);
    slots[idx] = true;
    this.rollout.events.push({ at: nowIso(), type: 'advanced', slot: idx, plugin: target.plugins[idx].pluginId });
    this.emit('changed', { type: 'slot_advanced', id: this.rollout.id, slot: idx });

    if (slots.every(Boolean)) this._finalize();
    return this.status();
  }

  /** 回退：所有槽位退回 base，滚动取消，活动链指针不变。 */
  rollback() {
    if (!this.rollout) throw new GatewayError(409, 'no_rollout', 'no rollout in progress');
    const r = this.rollout;
    r.slots = r.slots.map(() => false);
    r.events.push({ at: nowIso(), type: 'rolled_back' });
    this.history.push({ id: r.id, target: r.target.revLabel, result: 'rolled_back', at: nowIso() });
    this.rollout = null;
    this.emit('changed', { type: 'rollout_rolled_back' });
    return { ok: true, active: this.store.active().revLabel };
  }

  _finalize() {
    const r = this.rollout;
    r.events.push({ at: nowIso(), type: 'finalized' });
    // 全部槽位已是 target -> 原子提交指针，活动链切到 target
    this.store.deploy(r.target.id, { reason: `rolling rollout ${r.id} finalized` });
    this.history.push({
      id: r.id,
      base: r.base.revLabel,
      target: r.target.revLabel,
      result: 'finalized',
      at: nowIso(),
    });
    this.rollout = null;
    this.emit('changed', { type: 'rollout_finalized', target: r.target.revLabel });
  }

  status() {
    if (!this.rollout) return { active: false, history: this.history.slice(-10) };
    const r = this.rollout;
    return {
      active: true,
      id: r.id,
      base: r.base.revLabel,
      target: r.target.revLabel,
      contextVersion: r.target.contextVersion,
      slots: r.slots.map((onTarget, i) => ({
        slot: i,
        plugin: r.target.plugins[i].pluginId,
        source: onTarget ? 'target' : 'base',
      })),
      advancedCount: r.slots.filter(Boolean).length,
      totalSlots: r.slots.length,
      startedAt: r.startedAt,
      events: r.events,
    };
  }
}
