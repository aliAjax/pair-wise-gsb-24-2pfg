// 客户端状态：在线/离线、outbox 状态机、草稿、统计重算标记
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  BatchPayload,
  DraftState,
  FieldReg,
  LocalLogLine,
  OutboxOp,
  ServerEvent,
  Snapshot,
  StratumRange,
} from "./types";
import {
  ConflictError,
  NetworkError,
  ServerRejectError,
  allocateBatchNo,
  finalizeBatch,
  loadSnapshot,
  registerField,
  resolveStratum,
  sealUnit,
  subscribe,
  uid,
  writeBatchRow,
} from "./server";
import { RecalcMark, computeStat, loadMarks, saveMarks, sealBlockers, statHash } from "./sync";

const CLIENT_KEY = "hxwl10.clientId";

function getClientId(): string {
  let id = sessionStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = uid("C-");
    sessionStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

const OUTBOX_KEY = "hxwl10.outbox.v1";
const DRAFTS_KEY = "hxwl10.drafts.v1";

function loadPersisted<T>(key: string, clientId: string, fallback: T): T {
  try {
    const all = JSON.parse(localStorage.getItem(key) || "{}") as Record<string, T>;
    return (all[clientId] as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function persist<T>(key: string, clientId: string, value: T) {
  try {
    const all = JSON.parse(localStorage.getItem(key) || "{}") as Record<string, T>;
    all[clientId] = value;
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

interface StoreState {
  clientId: string;
  online: boolean;
  ready: boolean;
  snap: Snapshot;
  outbox: OutboxOp[];
  drafts: DraftState[];
  logs: LocalLogLine[];
  marks: Record<string, RecalcMark>;
}

interface StoreApi extends StoreState {
  toggleOnline: () => void;
  registerField: (reg: FieldReg) => Promise<void>;
  createDraft: (
    payload: Omit<BatchPayload, "batchNo" | "baseVersion"> & { baseVersion?: number; batchNo?: string }
  ) => string;
  saveDraft: (batchNo: string, updater: (p: BatchPayload) => BatchPayload) => void;
  discardDraft: (batchNo: string) => void;
  submitDraft: (batchNo: string) => Promise<void>;
  retryOp: (id: string) => Promise<void>;
  resolveStratum: (bagNo: string, range: StratumRange) => Promise<void>;
  sealUnit: (code: string) => Promise<string | null>;
  recalc: (code: string) => void;
  unitBlockers: (code: string) => string[];
  unitStat: (code: string) => ReturnType<typeof computeStat>;
  appendLog: (kind: string, text: string) => void;
}

const StoreContext = createContext<StoreApi | null>(null);

function localBatchNo(clientId: string): string {
  return `本地-${clientId.slice(2, 6)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function isLocalBatchNo(no: string): boolean {
  return no.startsWith("本地-");
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const clientId = useMemo(getClientId, []);
  const [state, setState] = useState<StoreState>(() => ({
    clientId,
    online: navigator.onLine ?? true,
    ready: false,
    snap: { units: [], samples: {}, batches: {}, idemCount: 0 },
    outbox: loadPersisted<OutboxOp[]>(OUTBOX_KEY, clientId, []),
    drafts: loadPersisted<DraftState[]>(DRAFTS_KEY, clientId, []),
    logs: [],
    marks: loadMarks(),
  }));

  const stateRef = useRef(state);
  stateRef.current = state;
  const processingRef = useRef(false);

  const appendLog = useCallback((kind: string, text: string) => {
    setState((s) => ({
      ...s,
      logs: [{ id: uid("L-"), at: Date.now(), kind, text }, ...s.logs].slice(0, 80),
    }));
  }, []);

  // ---------- outbox 处理（断点重放） ----------

  const patchOp = useCallback((id: string, patch: Partial<OutboxOp>, line?: string) => {
    setState((s) => ({
      ...s,
      outbox: s.outbox.map((op) =>
        op.id === id
          ? {
              ...op,
              ...patch,
              logs: line ? [...op.logs, { at: Date.now(), text: line }] : op.logs,
            }
          : op
      ),
    }));
  }, []);

  const runOp = useCallback(
    async (op: OutboxOp) => {
      patchOp(op.id, { status: "running", attempts: op.attempts + 1 }, `开始处理（第 ${op.attempts + 1} 次尝试）`);
      try {
        if (op.kind === "field-register") {
          const reg = op.field!;
          const res = await registerField(op.id, reg);
          patchOp(
            op.id,
            { status: "done", message: res.merged ? "已按袋号合并到既有记录" : "已新建土样记录" },
            res.merged
              ? `袋号 ${reg.bagNo} 已存在：逐件合并，现场/实验室原值各自保留，认领取并集`
              : `袋号 ${reg.bagNo}（${reg.unitCode}）写入完成`
          );
          appendLog("field", `现场登记 ${reg.bagNo} ${res.merged ? "合并" : "新建"}成功`);
          return;
        }

        const payload = op.batch!;
        // 批次号：提交前若还是本地临号，此刻向服务器占用一个正式号；
        // 一旦占用成功就写进 op，后续重放永远复用，绝不二次占用
        let batchNo = payload.batchNo;
        if (isLocalBatchNo(batchNo)) {
          patchOp(op.id, {}, "向服务器申请正式批次号…");
          batchNo = await allocateBatchNo(op.id);
          payload.batchNo = batchNo;
          setState((s) => ({
            ...s,
            outbox: s.outbox.map((x) => (x.id === op.id ? { ...x, batch: { ...payload } } : x)),
            drafts: s.drafts.map((d) =>
              d.payload.batchNo === op.batch?.batchNo ? { ...d, payload: { ...d.payload, batchNo } } : d
            ),
          }));
          patchOp(op.id, {}, `已占用正式批次号 ${batchNo}（重放复用，不再重新申请）`);
        }

        // 逐袋写入：只补未完成的；completedBags 做断点
        const done = new Set(op.completedBags);
        for (const row of payload.rows) {
          if (done.has(row.bagNo)) continue;
          await writeBatchRow(op.id, payload, row.bagNo);
          done.add(row.bagNo);
          patchOp(op.id, { completedBags: [...done] }, `袋 ${row.bagNo} 写入完成（进度 ${done.size}/${payload.rows.length}）`);
        }

        const fin = await finalizeBatch(op.id, payload);
        patchOp(op.id, { status: "done", message: `已提交，版本 v${fin.version}` }, `提交成功：批次 ${fin.batchNo} v${fin.version}`);
        appendLog("batch", `批次 ${fin.batchNo} 提交成功（v${fin.version}），引用探方统计已失效待重算`);
        setState((s) => ({ ...s, drafts: s.drafts.filter((d) => d.payload.batchNo !== payload.batchNo) }));
      } catch (e) {
        if (e instanceof ConflictError) {
          patchOp(
            op.id,
            { status: "conflict", message: `版本冲突：服务器版本 v${e.serverVersion}` },
            `被拒：另一窗口已抢先提交（服务器 v${e.serverVersion}）。草稿保留，可查看差异后续传`
          );
          setState((s) => ({
            ...s,
            drafts: s.drafts.map((d) =>
              d.payload.batchNo === op.batch?.batchNo
                ? { ...d, conflict: { serverVersion: e.serverVersion, at: Date.now() } }
                : d
            ),
          }));
          appendLog("conflict", `批次 ${op.batch?.batchNo} 提交冲突：只放行一份，本窗口保留草稿`);
        } else if (e instanceof NetworkError || e instanceof ServerRejectError) {
          patchOp(
            op.id,
            { status: "error", message: e.message },
            e instanceof NetworkError ? "网络故障中断：已完成袋保留，回连后只补未完成袋" : `服务器拒绝：${e.message}`
          );
          appendLog("error", `批次 ${op.batch?.batchNo} 中断，已完成 ${op.completedBags.length} 袋，等待重放`);
        } else {
          patchOp(op.id, { status: "error", message: String(e) });
        }
      }
    },
    [appendLog, patchOp]
  );

  const pump = useCallback(async () => {
    if (processingRef.current) return;
    const s0 = stateRef.current;
    if (!s0.online) return;
    const pending = s0.outbox.find((op) => op.status === "waiting" || op.status === "error");
    if (!pending) return;
    processingRef.current = true;
    try {
      await runOp(pending);
    } finally {
      processingRef.current = false;
    }
    // 还有待处理项就继续泵
    const s1 = stateRef.current;
    if (s1.online && s1.outbox.some((op) => op.status === "waiting" || op.status === "error")) {
      void pump();
    }
  }, [runOp]);

  // ---------- 初始化与订阅 ----------

  const refresh = useCallback(async () => {
    const snap = await loadSnapshot();
    setState((s) => ({ ...s, ready: true, snap }));
  }, []);

  useEffect(() => {
    void refresh();
    const unsub = subscribe((ev: ServerEvent) => {
      void refresh();
      if (ev.id >= 0) {
        setState((s) => ({
          ...s,
          logs: [{ id: uid("L-"), at: ev.at, kind: "server:" + ev.kind, text: ev.text }, ...s.logs].slice(0, 80),
        }));
      }
    });
    return unsub;
  }, [refresh]);

  // 离线/在线切换（含浏览器真实事件）；回连自动按 outbox 顺序重放
  useEffect(() => {
    const goOnline = () => {
      setState((s) => ({ ...s, online: true }));
      appendLog("sync", "网络恢复：按袋号逐件合并 outbox，断点重放只补未完成样本");
    };
    const goOffline = () => {
      setState((s) => ({ ...s, online: false }));
      appendLog("sync", "进入离线：现场登记与批次草稿本地暂存");
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [appendLog]);

  useEffect(() => {
    if (state.online && state.ready) void pump();
  }, [state.online, state.ready, state.outbox, pump]);

  // 本地持久化（刷新页面也能续作）
  useEffect(() => persist(OUTBOX_KEY, clientId, state.outbox), [clientId, state.outbox]);
  useEffect(() => persist(DRAFTS_KEY, clientId, state.drafts), [clientId, state.drafts]);
  useEffect(() => saveMarks(state.marks), [state.marks]);

  // ---------- 动作 ----------

  const toggleOnline = useCallback(() => {
    setState((s) => {
      const online = !s.online;
      return { ...s, online };
    });
  }, []);

  const enqueue = useCallback(
    (op: OutboxOp) => {
      setState((s) => ({ ...s, outbox: [op, ...s.outbox] }));
    },
    []
  );

  const registerFieldAction = useCallback(
    async (reg: FieldReg) => {
      const op: OutboxOp = {
        id: uid("OP-"),
        kind: "field-register",
        clientId,
        createdAt: Date.now(),
        status: "waiting",
        attempts: 0,
        completedBags: [],
        field: reg,
        logs: [],
      };
      enqueue(op);
      appendLog("field", stateRef.current.online ? `现场登记 ${reg.bagNo} 入队，等待回连合并` : `离线登记 ${reg.bagNo}（${reg.unitCode}）已存本地`);
    },
    [appendLog, clientId, enqueue]
  );

  const createDraft = useCallback(
    (p: Omit<BatchPayload, "batchNo" | "baseVersion"> & { baseVersion?: number; batchNo?: string }): string => {
      const batchNo = p.batchNo ?? localBatchNo(clientId);
      const payload: BatchPayload = { ...p, batchNo, baseVersion: p.baseVersion ?? 0 };
      setState((s) => ({ ...s, drafts: [...s.drafts, { payload }] }));
      return batchNo;
    },
    [clientId]
  );

  const saveDraft = useCallback((batchNo: string, updater: (p: BatchPayload) => BatchPayload) => {
    setState((s) => ({
      ...s,
      drafts: s.drafts.map((d) => (d.payload.batchNo === batchNo ? { payload: updater(d.payload), conflict: undefined } : d)),
    }));
  }, []);

  const discardDraft = useCallback((batchNo: string) => {
    setState((s) => ({ ...s, drafts: s.drafts.filter((d) => d.payload.batchNo !== batchNo) }));
  }, []);

  const submitDraft = useCallback(
    async (batchNo: string) => {
      const draft = stateRef.current.drafts.find((d) => d.payload.batchNo === batchNo);
      if (!draft) return;
      const op: OutboxOp = {
        id: uid("OP-"),
        kind: "batch-submit",
        clientId,
        createdAt: Date.now(),
        status: "waiting",
        attempts: 0,
        completedBags: [],
        batch: structuredClone(draft.payload),
        logs: [],
      };
      enqueue(op);
      appendLog(
        "batch",
        stateRef.current.online
          ? `批次 ${batchNo} 提交中（逐袋写入 + 版本校验）`
          : `批次 ${batchNo} 离线暂存，回连后提交`
      );
    },
    [appendLog, clientId, enqueue]
  );

  const retryOp = useCallback(
    async (id: string) => {
      const op = stateRef.current.outbox.find((x) => x.id === id);
      if (!op || (op.status !== "error" && op.status !== "conflict")) return;
      if (op.kind === "batch-submit" && op.status === "conflict") {
        // 冲突重试前必须先刷新基底版本；这里直接取服务器当前版本并清掉冲突标记
        const cur = stateRef.current.snap.batches[op.batch!.batchNo];
        const baseVersion = cur ? cur.version : 0;
        op.batch!.baseVersion = baseVersion;
        setState((s) => ({
          ...s,
          outbox: s.outbox.map((x) => (x.id === id ? { ...x, batch: { ...op.batch! }, status: "waiting", completedBags: [] } : x)),
          drafts: s.drafts.map((d) =>
            d.payload.batchNo === op.batch!.batchNo ? { payload: { ...d.payload, baseVersion }, conflict: undefined } : d
          ),
        }));
        appendLog("conflict", `批次 ${op.batch!.batchNo} 已按服务器 v${baseVersion} 续传（仍逐袋幂等写入）`);
        return;
      }
      setState((s) => ({ ...s, outbox: s.outbox.map((x) => (x.id === id ? { ...x, status: "waiting" } : x)) }));
    },
    [appendLog]
  );

  const resolveStratumAction = useCallback(
    async (bagNo: string, range: StratumRange) => {
      await resolveStratum(bagNo, range, clientId);
      appendLog("resolve", `领队核对 ${bagNo}：采用${range.from === range.to ? `第${range.from}层` : `第${range.from}–${range.to}层`}`);
      await refresh();
    },
    [appendLog, clientId, refresh]
  );

  const recalc = useCallback((code: string) => {
    setState((s) => {
      const marks = { ...s.marks, [code]: { hash: statHash(s.snap, code), at: Date.now() } };
      return { ...s, marks };
    });
    appendLog("recalc", `探方 ${code} 统计已按最新浮选结果重算`);
  }, [appendLog]);

  const sealUnitAction = useCallback(
    async (code: string): Promise<string | null> => {
      const blockers = sealBlockers(stateRef.current.snap, code, stateRef.current.marks);
      if (blockers.length) return blockers[0];
      await sealUnit(code);
      appendLog("seal", `探方 ${code} 封存成功`);
      await refresh();
      return null;
    },
    [appendLog, refresh]
  );

  const unitBlockers = useCallback(
    (code: string) => sealBlockers(stateRef.current.snap, code, stateRef.current.marks),
    []
  );

  const unitStat = useCallback((code: string) => computeStat(stateRef.current.snap, code), []);

  const api: StoreApi = {
    ...state,
    toggleOnline,
    registerField: registerFieldAction,
    createDraft,
    saveDraft,
    discardDraft,
    submitDraft,
    retryOp,
    resolveStratum: resolveStratumAction,
    sealUnit: sealUnitAction,
    recalc,
    unitBlockers,
    unitStat,
    appendLog,
  };

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreApi {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
