import { ServerApi, ApiError } from "./api";
import type { ClientData } from "./store";
import type {
  BatchDraft,
  FlotationResult,
  OutboxOp,
  SquareStats,
  StratumConflict,
  Toast,
} from "./types";

const LS_KEY = (w: string) => `arch-sync-client:${w}`;

type Listener = () => void;

/** 现场端：离线登记 + 回连按袋号合并 + 仅重放未完成样本 */
export class ClientEngine {
  data: ClientData;
  private listeners = new Set<Listener>();

  constructor(
    public windowId: string,
    private api: ServerApi,
    online = true,
  ) {
    this.data = this.load() ?? {
      windowId,
      online,
      server: null,
      queue: [],
      drafts: {},
      fieldBags: {},
      batchComposer: { bagNos: [], squareId: "T0203", result: null },
      statsStale: {},
      toasts: [],
    };
    this.data.online = online;
    this.pull();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.save();
    this.listeners.forEach((fn) => fn());
  }

  toast(level: Toast["level"], text: string) {
    this.data.toasts = [
      ...this.data.toasts,
      { id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, level, text, at: Date.now() },
    ].slice(-6);
    this.emit();
  }

  dismissToast(id: string) {
    this.data.toasts = this.data.toasts.filter((t) => t.id !== id);
    this.emit();
  }

  private load(): ClientData | null {
    try {
      const raw = localStorage.getItem(LS_KEY(this.windowId));
      return raw ? (JSON.parse(raw) as ClientData) : null;
    } catch {
      return null;
    }
  }

  private save() {
    try {
      // server 快照不持久化，回连后重新拉取
      const { server: _server, ...rest } = this.data;
      localStorage.setItem(LS_KEY(this.windowId), JSON.stringify(rest));
    } catch {
      /* 存储不可用时仅内存运行 */
    }
  }

  get online() {
    return this.data.online;
  }

  setOnline(v: boolean) {
    this.data.online = v;
    this.emit();
    if (v) this.syncQueue("回连");
    else this.toast("warn", `窗口 ${this.windowId} 已离线，登记进入本地队列`);
  }

  pull() {
    this.data.server = this.api.snapshot();
    this.emit();
  }

  // ---- 现场离线登记 ----------------------------------------------------

  registerFieldBag(bagNo: string, squareId: string, stratumRaw: string) {
    const now = Date.now();
    this.data.fieldBags[bagNo] = { bagNo, squareId, stratumRaw, at: now };
    const op: OutboxOp = {
      id: `op-${now}-${Math.random().toString(36).slice(2, 6)}`,
      kind: "register-bag",
      state: "queued",
      attempts: 0,
      payload: { bagNo, squareId, stratumRaw, source: "field" },
      createdAt: now,
      updatedAt: now,
    };
    this.data.queue = [...this.data.queue, op];
    this.emit();
    if (this.data.online) this.drainOp(op.id);
  }

  // ---- 批次草稿与提交 --------------------------------------------------

  composerToggleBag(bagNo: string, squareId: string) {
    const c = this.data.batchComposer;
    const bagNos = c.bagNos.includes(bagNo)
      ? c.bagNos.filter((b) => b !== bagNo)
      : [...c.bagNos, bagNo];
    this.data.batchComposer = { ...c, bagNos, squareId };
    this.emit();
  }

  composerSetSquare(squareId: string) {
    this.data.batchComposer = { ...this.data.batchComposer, squareId, bagNos: [] };
    this.emit();
  }

  composerSetResult(result: FlotationResult | null) {
    this.data.batchComposer = { ...this.data.batchComposer, result };
    this.emit();
  }

  /** 提交批次：成功即清草稿；并发失败保留草稿+冲突提示；部分失败进入可续作状态 */
  submitComposedBatch(failAfter?: number): string {
    const c = this.data.batchComposer;
    const draftId = `FB-${this.windowId}-${Date.now().toString(36)}`;
    if (c.bagNos.length === 0) {
      this.toast("warn", "草稿为空：先勾选袋号");
      return draftId;
    }
    const samples = c.bagNos.map((bagNo) => ({ bagNo, squareId: c.squareId }));
    const now = Date.now();
    const op: OutboxOp = {
      id: `op-${now}-${Math.random().toString(36).slice(2, 6)}`,
      kind: "submit-batch",
      state: "queued",
      attempts: 0,
      finishedBagNos: [],
      payload: { draftId, origin: "field" as const, samples, result: c.result, failAfter },
      createdAt: now,
      updatedAt: now,
    };
    this.data.queue = [...this.data.queue, op];
    this.emit();
    if (this.data.online) this.drainOp(op.id);
    else this.toast("info", `批次草稿 ${draftId} 已离线暂存，回连后提交`);
    return draftId;
  }

  retryOp(opId: string) {
    this.drainOp(opId);
  }

  /** 并发演练：本窗口与另一窗口用同一 draftId 同内容同时提交，只放行一份 */
  submitConcurrentSameDraft(
    other: ClientEngine,
    samples: { bagNo: string; squareId: string }[],
    result: FlotationResult | null,
  ): string {
    const draftId = `FB-race-${Date.now().toString(36)}`;
    const make = (): OutboxOp => ({
      id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: "submit-batch",
      state: "queued",
      attempts: 0,
      finishedBagNos: [],
      payload: { draftId, origin: "field" as const, samples, result },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    this.data.queue = [...this.data.queue, make()];
    other.data.queue = [...other.data.queue, make()];
    this.emit();
    other.toast("info", `收到同一批次草稿 ${draftId}，与另一窗口同时提交`);
    if (this.data.online && other.data.online) {
      this.drainOp(this.data.queue[this.data.queue.length - 1].id);
      other.drainOp(other.data.queue[other.data.queue.length - 1].id);
    }
    return draftId;
  }

  /** 回连后重放整个队列：已完成的不重复；register 幂等（按袋号 upsert） */
  syncQueue(reason = "手动") {
    if (!this.data.online) return;
    this.pull();
    const pending = this.data.queue.filter((o) =>
      ["queued", "inflight", "error"].includes(o.state),
    );
    if (pending.length === 0) {
      this.toast("info", `${reason}同步：队列无待办`);
      return;
    }
    this.toast("info", `${reason}同步：重放 ${pending.length} 条操作`);
    for (const op of pending) this.drainOp(op.id, true);
    this.pull();
  }

  private patchOp(opId: string, patch: Partial<OutboxOp>) {
    this.data.queue = this.data.queue.map((o) =>
      o.id === opId ? { ...o, ...patch, updatedAt: Date.now() } : o,
    );
  }

  private drainOp(opId: string, silent = false) {
    const op = this.data.queue.find((o) => o.id === opId);
    if (!op || !this.data.online) return;
    this.patchOp(opId, { state: "inflight", attempts: op.attempts + 1 });
    this.emit();

    try {
      if (op.kind === "register-bag") {
        const p = op.payload as {
          bagNo: string;
          squareId: string;
          stratumRaw: string;
          source: "field" | "lab";
        };
        const res = this.api.registerBag(p);
        this.patchOp(opId, { state: "done" });
        delete this.data.fieldBags[p.bagNo];
        if (!silent)
          this.toast(
            res.conflicted ? "warn" : "success",
            res.conflicted
              ? `袋 ${p.bagNo} 已合并，现场/实验室地层原值不一致，留待领队核对`
              : `袋 ${p.bagNo} 已按袋号合并`,
          );
      } else if (op.kind === "submit-batch") {
        const p = op.payload as {
          draftId: string;
          origin: "field" | "lab";
          samples: { bagNo: string; squareId: string }[];
          result: FlotationResult | null;
          failAfter?: number;
        };
        try {
          // 故障注入只在首次尝试前布防；重放路径不再注入
          if (p.failAfter !== undefined && op.attempts === 1) {
            this.api.armFailure(p.draftId, p.failAfter);
          }
          const res = this.api.submitBatch({
            draftId: p.draftId,
            windowId: this.windowId,
            origin: p.origin,
            samples: p.samples,
            result: p.result,
            finishedBagNos: op.finishedBagNos,
          });
          const remaining = p.samples.filter(
            (s) => !res.written.includes(s.bagNo),
          ).length;
          if (remaining === 0 && res.completed) {
            this.patchOp(opId, { state: "done", finishedBagNos: res.written });
            delete this.data.drafts[p.draftId];
            this.data.batchComposer = { bagNos: [], squareId: "T0203", result: null };
            this.toast("success", `批次 ${res.batch.batchNo} 全部写入完成（${res.written.length} 件）`);
          } else {
            this.patchOp(opId, {
              state: "error",
              lastError: `仍有 ${remaining} 件未完成`,
              finishedBagNos: res.written,
            });
          }
          res.staleSquareIds.forEach((sq) => (this.data.statsStale[sq] = true));
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            // 并发提交：放行另一份，本份保留草稿与冲突提示
            const p2 = op.payload as {
              draftId: string;
              samples: { bagNo: string; squareId: string }[];
              squareId?: string;
              result: FlotationResult | null;
            };
            const extra = e.extra as { winnerBatchId: string; winnerWindowId: string };
            const draft: BatchDraft = {
              id: p2.draftId,
              bagNos: p2.samples.map((s) => s.bagNo),
              squareId: p2.samples[0]?.squareId ?? "",
              result: p2.result,
              conflictNote: `另一窗口 ${extra.winnerWindowId} 已先提交并占用批次号（${extra.winnerBatchId}），本份保留为草稿，未占用批次号`,
              updatedAt: Date.now(),
            };
            this.data.drafts = { ...this.data.drafts, [draft.id]: draft };
            this.patchOp(opId, { state: "conflict", lastError: e.message });
            this.toast("danger", `并发冲突：${e.message}`);
          } else if (e instanceof ApiError && e.status === 500) {
            // 写入失败：记录已完成件，只重做剩余样本，批次号已分配不会重发
            const finished = (e.extra as { finishedBagNos: string[] }).finishedBagNos;
            this.patchOp(opId, {
              state: "error",
              lastError: e.message,
              finishedBagNos: finished,
            });
            this.toast(
              "warn",
              `写入中断：已完成 ${finished.length} 件，保留进度，回连/重试只补剩余件`,
            );
          } else {
            throw e;
          }
        }
      } else if (op.kind === "update-result") {
        const p = op.payload as { batchId: string; patch: Partial<FlotationResult> };
        const res = this.api.updateResult(p.batchId, p.patch);
        this.patchOp(opId, { state: "done" });
        res.staleSquareIds.forEach((sq) => (this.data.statsStale[sq] = true));
        this.toast("warn", `浮选结果已修订（v${res.batch.result?.version}），相关探方统计失效待重算`);
      }
      this.pull();
    } catch (e) {
      this.patchOp(opId, {
        state: "error",
        lastError: e instanceof Error ? e.message : String(e),
      });
      this.emit();
    }
  }

  // ---- 由实验室端发起的结果修订（同样走队列以支持离线） ----------------

  requestResultUpdate(batchId: string, patch: Partial<FlotationResult>) {
    const now = Date.now();
    const op: OutboxOp = {
      id: `op-${now}-${Math.random().toString(36).slice(2, 6)}`,
      kind: "update-result",
      state: "queued",
      attempts: 0,
      payload: { batchId, patch },
      createdAt: now,
      updatedAt: now,
    };
    this.data.queue = [...this.data.queue, op];
    this.emit();
    if (this.data.online) this.drainOp(op.id);
  }

  recompute(squareId: string): SquareStats {
    const stats = this.api.recompute(squareId);
    this.data.statsStale = { ...this.data.statsStale, [squareId]: false };
    this.pull();
    this.toast("success", `探方 ${squareId} 统计已按最新浮选结果重算`);
    return stats;
  }

  seal(squareId: string) {
    const res = this.api.sealSquare(squareId);
    this.pull();
    if (res.ok) this.toast("success", `探方 ${squareId} 已封存`);
    else
      this.toast(
        "danger",
        `封存被挡：${[...res.gate.blockers, ...res.gate.warnings].join("；") || "存在未决项"}`,
      );
    return res;
  }

  resolveConflict(bagNo: string, value: string): StratumConflict {
    const c = this.api.resolveConflict(bagNo, value);
    this.pull();
    this.toast("success", `袋 ${bagNo} 地层冲突已经领队核对：${value}`);
    return c;
  }
}
