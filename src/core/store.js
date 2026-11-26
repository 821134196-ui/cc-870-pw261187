import { EventEmitter } from 'node:events';
import { ChainSnapshot } from './chain.js';
import { GatewayError } from './errors.js';
import { nowIso } from './utils.js';

/**
 * ChainStore —— 链配置的状态机与活动指针持有者。
 *
 * 状态机（每条链按 rev 演进）：
 *   draft（未确认，绝不接流量）
 *     --confirm(兼容性闸门)--> confirmed
 *     --deploy(原子热切换)--> 成为 active，旧 active 成为 previous
 *
 * 安全性质：
 *  1. active 永远指向一个已通过 preflight 的不可变 ChainSnapshot；
 *  2. 切换是一次指针赋值（Node 单线程内原子），进行中的请求持旧引用不受影响；
 *  3. 未确认链无法部署 —— "一条请求经过的多个插件必须来自同一条已确认的链"。
 */
export class ChainStore extends EventEmitter {
  constructor(pluginRegistry, seed = []) {
    super();
    this.pluginRegistry = pluginRegistry;
    /** @type {Map<string, ChainSnapshot>} drafts 与 confirmed 都在这里，按 id 存最新 rev */
    this.chains = new Map();
    this.activeId = null;
    this.previousSnapshot = null;
    this.history = [];

    for (const def of seed) this._put(new ChainSnapshot(def, pluginRegistry));
  }

  _put(snapshot) {
    this.chains.set(snapshot.id, snapshot);
  }

  list() {
    return [...this.chains.values()].map((s) => ({
      ...s.describe(),
      active: s.id === this.activeId && this.active() === s,
    }));
  }

  get(id) {
    const s = this.chains.get(id);
    if (!s) throw new GatewayError(404, 'chain_not_found', `chain "${id}" does not exist`);
    return s;
  }

  active() {
    if (!this.activeId) return null;
    return this.chains.get(this.activeId) ?? null;
  }

  /** 创建/更新草稿：rev 自增、confirmed 强制为 false。 */
  saveDraft(def) {
    const existing = this.chains.get(def.id);
    const nextDef = {
      ...def,
      rev: (existing?.rev ?? 0) + 1,
      confirmed: false,
      createdAt: nowIso(),
    };
    let snapshot;
    try {
      snapshot = new ChainSnapshot(nextDef, this.pluginRegistry);
    } catch (err) {
      throw err;
    }
    this._put(snapshot);
    this.emit('changed', { type: 'draft_saved', chainId: snapshot.id, rev: snapshot.rev });
    return snapshot;
  }

  /**
   * 确认链：运行兼容性闸门（逐插件检查上下文版本）。
   * 失败 -> 409，链保持 draft；成功 -> 替换为 confirmed 快照。
   */
  confirm(id) {
    const draft = this.get(id);
    if (draft.confirmed) return draft;

    const preflight = draft.preflight(); // 不兼容时抛 GatewayError(409 context_incompatible)
    const confirmed = new ChainSnapshot(
      { ...draft.describe(), confirmed: true },
      this.pluginRegistry,
    );
    this._put(confirmed);
    this.emit('changed', {
      type: 'confirmed',
      chainId: confirmed.id,
      rev: confirmed.rev,
      checks: preflight.checks,
    });
    return confirmed;
  }

  /**
   * 原子热切换（整条链一次性替换）。
   * 唯一会改变活动指针的入口；允许跨上下文版本（preflight 已保证链内部自洽）。
   */
  deploy(id, meta = {}) {
    const snapshot = this.get(id);
    if (!snapshot.confirmed) {
      throw new GatewayError(409, 'chain_not_confirmed',
        `chain "${id}" is not confirmed — only confirmed chains may receive traffic`);
    }
    if (this.activeId === id) {
      throw new GatewayError(409, 'already_active', `chain "${id}" is already active`);
    }
    const previous = this.active();
    this.previousSnapshot = previous;
    this.activeId = id;
    const record = {
      at: nowIso(),
      from: previous?.revLabel ?? null,
      to: snapshot.revLabel,
      mode: 'hot-atomic',
      reason: meta.reason ?? 'manual deploy',
    };
    this.history.push(record);
    this.emit('changed', { type: 'active_changed', ...record });
    return { active: snapshot, previous, record };
  }

  /** 回退：优先回到上一条活动快照；也可显式指定目标链（必须已确认）。 */
  rollback(targetId = null) {
    let target;
    if (targetId) {
      target = this.get(targetId);
      if (!target.confirmed) {
        throw new GatewayError(409, 'chain_not_confirmed', `rollback target "${targetId}" is not confirmed`);
      }
    } else {
      target = this.previousSnapshot;
      if (!target) throw new GatewayError(409, 'no_rollback_target', 'no previous chain to roll back to');
    }
    const previous = this.active();
    this.activeId = target.id;
    this.previousSnapshot = previous;
    const record = {
      at: nowIso(),
      from: previous?.revLabel ?? null,
      to: target.revLabel,
      mode: 'rollback',
      reason: 'verified fallback',
    };
    this.history.push(record);
    this.emit('changed', { type: 'active_changed', ...record });
    return { active: target, previous, record };
  }

  state() {
    const active = this.active();
    return {
      active: active ? active.revLabel : null,
      activeChain: active ? active.describe() : null,
      previous: this.previousSnapshot?.revLabel ?? null,
      history: this.history.slice(-20),
      chains: this.list(),
    };
  }
}
