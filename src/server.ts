// 模拟"服务器"：localStorage 持久化、跨标签页共享（storage 事件 + BroadcastChannel）
// 真实后端语义：延迟、乐观锁版本、幂等表、逐行写入、并发互斥、可注入网络故障
import type {
  BatchPayload,
  FieldReg,
  FlotResult,
  ServerBatch,
  ServerDB,
  ServerEvent,
  ServerSample,
  Snapshot,
  StratumRange,
} from "./types";

const DB_KEY = "hxwl10.server.v1";
const CHANNEL = "hxwl10.server";

export class NetworkError extends Error {
  constructor() {
    super("网络故障：写入未完成，回连后只重放未完成的样本");
    this.name = "NetworkError";
  }
}

export class ConflictError extends Error {
  serverVersion: number;
  constructor(serverVersion: number) {
    super("批次已被另一个窗口提交（版本冲突）");
    this.name = "ConflictError";
    this.serverVersion = serverVersion;
  }
}

export class ServerRejectError extends Error {}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const latency = () => 140 + Math.random() * 220;

export function uid(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return prefix + crypto.randomUUID().slice(0, 8);
  }
  return prefix + Math.random().toString(36).slice(2, 10);
}

const sameRange = (a: StratumRange | null, b: StratumRange | null) =>
  !!a && !!b && a.from === b.from && a.to === b.to;

function stratumStatusOf(s: Pick<ServerSample, "fieldStratum" | "labStratum" | "resolvedRange">): ServerSample["stratumStatus"] {
  if (!s.fieldStratum || !s.labStratum) return "unilateral";
  if (s.resolvedRange) return "resolved";
  return sameRange(s.fieldStratum, s.labStratum) ? "agree" : "conflict";
}

// ---------- 种子数据 ----------

function seed(): ServerDB {
  const now = Date.now();
  const units = [
    { code: "T0203", name: "西北区灰坑组", sealed: false },
    { code: "T0204", name: "北区红烧土面", sealed: false },
    { code: "T0301", name: "东区房址 F2", sealed: false },
  ];

  const mk = (
    bagNo: string,
    unitCode: string,
    fieldStratum: StratumRange | null,
    labStratum: StratumRange | null,
    labBatch: string | undefined,
    batchNos: string[],
    extra: Partial<ServerSample> = {}
  ): ServerSample => {
    const s: ServerSample = {
      bagNo,
      unitCode,
      fieldStratum,
      labStratum,
      labStratumBatchNo: labBatch,
      stratumStatus: "unilateral",
      batchNos,
      registeredAt: now - 86400000,
      updatedAt: now - 3600000,
      ...extra,
    };
    s.stratumStatus = stratumStatusOf(s);
    return s;
  };

  const r = (bagNo: string, charredG: number, seeds: number, status: FlotResult["status"] = "done", note?: string): FlotResult => ({
    bagNo,
    charredG,
    seeds,
    status,
    ...(note ? { note } : {}),
  });

  const samples: Record<string, ServerSample> = {
    // 现场与实验室地层不一致：双方原值保留，等待领队核对
    "S-1001": mk("S-1001", "T0203", { from: 3, to: 3 }, { from: 4, to: 4 }, "B-001", ["B-001"], { soilColor: "灰褐土" }),
    // 同一袋被两条批次认领
    "S-1002": mk("S-1002", "T0203", { from: 2, to: 3 }, { from: 2, to: 3 }, "B-001", ["B-001", "B-003"], { soilColor: "黄褐土" }),
    "S-1003": mk("S-1003", "T0203", { from: 5, to: 6 }, null, undefined, ["B-002"], { soilColor: "黑灰土" }),
    "S-2001": mk("S-2001", "T0204", { from: 2, to: 2 }, { from: 2, to: 3 }, "B-001", ["B-001"], { soilColor: "红烧土" }),
    "S-2002": mk("S-2002", "T0204", { from: 4, to: 5 }, { from: 4, to: 5 }, "B-002", ["B-002"], { soilColor: "褐土" }),
    // 只有实验室先认领、现场登记还没同步
    "S-3001": mk("S-3001", "T0301", null, { from: 1, to: 2 }, "B-003", ["B-003"]),
  };

  const batches: Record<string, ServerBatch> = {
    "B-001": {
      batchNo: "B-001",
      labCode: "浮选室甲 · 2026-09W3",
      version: 3,
      submittedAt: now - 7200000,
      bagNos: ["S-1001", "S-1002", "S-2001"],
      results: {
        "S-1001": r("S-1001", 2.4, 18),
        "S-1002": r("S-1002", 0.8, 6),
        "S-2001": r("S-2001", 1.1, 9, "done", "见稻属残粒"),
      },
    },
    "B-002": {
      batchNo: "B-002",
      labCode: "浮选室甲 · 2026-09W4",
      version: 1,
      submittedAt: now - 1800000,
      bagNos: ["S-1003", "S-2002"],
      results: {
        "S-1003": r("S-1003", 0, 0, "pending", "检测尚未回填"),
        "S-2002": r("S-2002", 1.9, 14),
      },
    },
    "B-003": {
      batchNo: "B-003",
      labCode: "浮选室乙 · 2026-10W1",
      version: 1,
      submittedAt: now - 600000,
      bagNos: ["S-1002", "S-3001"],
      results: {
        "S-1002": r("S-1002", 0.7, 5, "done", "复测批次"),
        "S-3001": r("S-3001", 0, 0, "pending"),
      },
    },
  };

  const db: ServerDB = {
    units,
    samples,
    batches,
    idem: {},
    stage: {},
    alloc: {},
    counter: 3,
    seq: 1,
    events: [{ id: 0, at: now - 90000000, kind: "seed", text: "载入种子档案：3 个探方、6 袋土样、3 条浮选批次" }],
  };
  return db;
}

// ---------- 存储 ----------

function readRaw(): ServerDB {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw) as ServerDB;
  } catch {
    /* fall through */
  }
  const db = seed();
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  return db;
}

function writeRaw(next: ServerDB, expectedSeq: number): boolean {
  const cur = readRaw();
  if (cur.seq !== expectedSeq) return false;
  next.seq = expectedSeq + 1;
  localStorage.setItem(DB_KEY, JSON.stringify(next));
  return true;
}

/** CAS 风格的读-改-写：跨标签页撞车自动重试 */
function mutate<T>(fn: (db: ServerDB) => T): T {
  for (let i = 0; i < 12; i++) {
    const db = readRaw();
    const expected = db.seq;
    const ret = fn(db);
    if (writeRaw(db, expected)) return ret;
  }
  throw new Error("存储繁忙，请重试");
}

// 跨标签页 / 本标签页互斥（Web Locks 不可用时退化为进程内链式锁）
const localChains = new Map<string, Promise<unknown>>();
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const nav = navigator as Navigator & { locks?: { request: (n: string, f: () => Promise<T>) => Promise<T> } };
  if (nav.locks?.request) return nav.locks.request(name, fn);
  // 降级：严格等前一个持有者（含其内部异步）完全结束再放行
  const prev = localChains.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  localChains.set(
    name,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL);
  return channel;
}

function appendEvent(db: ServerDB, kind: string, text: string): ServerEvent {
  const ev: ServerEvent = { id: db.events.length ? db.events[db.events.length - 1].id + 1 : 1, at: Date.now(), kind, text };
  db.events.push(ev);
  if (db.events.length > 120) db.events.splice(0, db.events.length - 120);
  return ev;
}

function publish(ev: ServerEvent) {
  getChannel()?.postMessage({ type: "change", event: ev });
}

// ---------- 故障注入（本标签页本地，仅演示用） ----------

const FAIL_KEY = "hxwl10.failpoints";
interface FailPoint {
  id: string;
  remain: number;
}
function readFails(): FailPoint[] {
  try {
    return JSON.parse(sessionStorage.getItem(FAIL_KEY) || "[]") as FailPoint[];
  } catch {
    return [];
  }
}
function hitFail(opId: string): void {
  const fails = readFails();
  const fp = fails.find((f) => f.id === opId);
  if (fp && fp.remain > 0) {
    fp.remain -= 1;
    sessionStorage.setItem(FAIL_KEY, JSON.stringify(fails));
    throw new NetworkError();
  }
}
export function injectFailures(opId: string, times: number) {
  const fails = readFails().filter((f) => f.id !== opId);
  fails.push({ id: opId, remain: times });
  sessionStorage.setItem(FAIL_KEY, JSON.stringify(fails));
}

// ---------- 公共 API ----------

export async function loadSnapshot(): Promise<Snapshot> {
  await delay(latency() / 2);
  const db = readRaw();
  return {
    units: db.units.map((u) => ({ ...u })),
    samples: structuredClone(db.samples),
    batches: structuredClone(db.batches),
    idemCount: Object.keys(db.idem).length,
  };
}

export function subscribe(cb: (ev: ServerEvent) => void): () => void {
  const ch = getChannel();
  const onMsg = (e: MessageEvent) => {
    if (e.data?.type === "change") cb(e.data.event as ServerEvent);
  };
  ch?.addEventListener("message", onMsg);
  const onStorage = (e: StorageEvent) => {
    if (e.key === DB_KEY) cb({ id: -1, at: Date.now(), kind: "storage", text: "其他标签页已写入服务器" });
  };
  window.addEventListener("storage", onStorage);
  return () => {
    ch?.removeEventListener("message", onMsg);
    window.removeEventListener("storage", onStorage);
  };
}

/** 批次号在登记草稿时即占用；重放凭幂等键取回原号，绝不二次占用 */
export async function allocateBatchNo(opId: string): Promise<string> {
  await delay(latency());
  hitFail(opId);
  return withLock("hxwl10-alloc", async () => {
    return mutate((db) => {
      const existed = db.alloc[opId];
      if (existed) return existed;
      db.counter += 1;
      const no = `B-${String(db.counter).padStart(3, "0")}`;
      db.alloc[opId] = no;
      appendEvent(db, "alloc", `占用批次号 ${no}`);
      return no;
    });
  });
}

/** 现场登记：按袋号逐件合并（同袋号不新建，认领取并集，双方地层原值各自保留） */
export async function registerField(opId: string, reg: FieldReg): Promise<{ merged: boolean; bagNo: string }> {
  await delay(latency());
  hitFail(opId);
  return withLock("hxwl10-write", async () => {
    const result = mutate<{ merged: boolean; bagNo: string; ev: ServerEvent }>((db) => {
      if (db.idem[opId]) return db.idem[opId].result as { merged: boolean; bagNo: string; ev: ServerEvent };
      const existed = db.samples[reg.bagNo];
      let merged: boolean;
      let ev: ServerEvent;
      if (existed) {
        merged = true;
        // 现场原值只在缺失时补；与实验室不一致时双方原值都留
        if (!existed.fieldStratum) {
          existed.fieldStratum = { ...reg.stratum };
          existed.stratumStatus = stratumStatusOf(existed);
        }
        if (reg.soilColor && !existed.soilColor) existed.soilColor = reg.soilColor;
        if (reg.weightKg != null && existed.weightKg == null) existed.weightKg = reg.weightKg;
        existed.updatedAt = Date.now();
        ev = appendEvent(db, "field-merge", `现场登记合并到已有袋号 ${reg.bagNo}（${reg.unitCode}），未覆盖任何原值`);
      } else {
        merged = false;
        const s: ServerSample = {
          bagNo: reg.bagNo,
          unitCode: reg.unitCode,
          fieldStratum: { ...reg.stratum },
          labStratum: null,
          stratumStatus: "unilateral",
          batchNos: [],
          soilColor: reg.soilColor,
          weightKg: reg.weightKg,
          registeredAt: Date.now(),
          updatedAt: Date.now(),
        };
        db.samples[reg.bagNo] = s;
        ev = appendEvent(db, "field-new", `现场离线登记回传：新建袋号 ${reg.bagNo}（${reg.unitCode}，第${reg.stratum.from}–${reg.stratum.to}层）`);
      }
      const out = { merged, bagNo: reg.bagNo, ev };
      db.idem[opId] = { at: Date.now(), result: out };
      return out;
    });
    publish(result.ev);
    return { merged: result.merged, bagNo: result.bagNo };
  });
}

/** 浮选批次逐袋写入（暂存）。同 opId+袋号 重复写入直接跳过：重放不重复占用。 */
export async function writeBatchRow(opId: string, payload: BatchPayload, bagNo: string): Promise<void> {
  await delay(latency());
  hitFail(opId);
  return withLock("hxwl10-write", async () => {
    const ev = mutate<ServerEvent | null>((db) => {
      const stage = (db.stage[payload.batchNo] ??= {
        batchNo: payload.batchNo,
        baseVersion: payload.baseVersion,
        rows: {},
      });
      if (stage.rows[bagNo]?.writtenBy.includes(opId)) return null; // 本 op 已完成该袋：幂等跳过
      const row = payload.rows.find((x) => x.bagNo === bagNo)!;
      const prev = stage.rows[bagNo];
      stage.rows[bagNo] = {
        writtenBy: [...(prev?.writtenBy ?? []), opId],
        lab: { ...row.lab },
        result: {
          bagNo,
          charredG: row.charredG,
          seeds: row.seeds,
          status: row.status,
          ...(row.note ? { note: row.note } : {}),
        },
      };
      stage.baseVersion = payload.baseVersion;
      return appendEvent(db, "row-write", `批次 ${payload.batchNo} 写入袋 ${bagNo}（${row.status === "done" ? "结果回填" : "检测仍在进行"}）`);
    });
    if (ev) publish(ev);
  });
}

/** 提交批次：CAS 版本校验，只有一个窗口放行；成功后结果变化即触发引用探方失效 */
export async function finalizeBatch(opId: string, payload: BatchPayload): Promise<{ batchNo: string; version: number }> {
  await delay(latency());
  hitFail(opId);
  return withLock("hxwl10-write", async () => {
    const out = mutate<{ batchNo: string; version: number; ev: ServerEvent; conflict?: number }>((db) => {
      if (db.idem[opId]) {
        const cached = db.idem[opId].result as { batchNo: string; version: number };
        return { ...cached, ev: { id: -1, at: Date.now(), kind: "replay", text: "幂等重放，直接返回原结果" } };
      }
      const stage = db.stage[payload.batchNo];

      // 1) 先做乐观锁版本校验：两个窗口同基底提交，必有一个在此被拒
      const cur = db.batches[payload.batchNo];
      const currentVersion = cur ? cur.version : 0;
      if (payload.baseVersion !== currentVersion) {
        throw new ConflictError(currentVersion);
      }

      // 2) 再检查本操作的逐袋写入 checkpoint（winner 提交后暂存会清掉，
      //    但败者已在上一步收到 ConflictError，不会误报"数据缺失"）
      const missing = payload.rows.filter((row) => !stage?.rows[row.bagNo]?.writtenBy.includes(opId)).map((r) => r.bagNo);
      if (missing.length) throw new ServerRejectError(`仍有 ${missing.length} 袋未写入：${missing.join("、")}`);

      const results: Record<string, FlotResult> = {};
      const touchedUnits = new Set<string>();
      for (const row of payload.rows) {
        const staged = stage!.rows[row.bagNo];
        results[row.bagNo] = { ...staged.result };

        const s =
          db.samples[row.bagNo] ??
          ((): ServerSample => {
            const fresh: ServerSample = {
              bagNo: row.bagNo,
              unitCode: "UNKNOWN",
              fieldStratum: null,
              labStratum: null,
              stratumStatus: "unilateral",
              batchNos: [],
              registeredAt: Date.now(),
              updatedAt: Date.now(),
            };
            db.samples[row.bagNo] = fresh;
            return fresh;
          })();

        // 认领取并集（一袋可被多条批次认领）
        if (!s.batchNos.includes(payload.batchNo)) s.batchNos.push(payload.batchNo);
        touchedUnits.add(s.unitCode);

        // 实验室地层原值独立保留，与现场不一致时挂冲突
        s.labStratum = { ...row.lab };
        s.labStratumBatchNo = payload.batchNo;
        if (s.resolvedRange) {
          // 领队曾核对过，新实验室值到达后需重新比对
          s.resolvedRange = undefined;
          s.resolvedBy = undefined;
          s.resolvedAt = undefined;
        }
        s.stratumStatus = stratumStatusOf(s);
        s.updatedAt = Date.now();
      }

      const version = currentVersion + 1;
      db.batches[payload.batchNo] = {
        batchNo: payload.batchNo,
        labCode: payload.labCode,
        version,
        submittedAt: Date.now(),
        bagNos: payload.rows.map((r) => r.bagNo),
        results,
      };
      delete db.stage[payload.batchNo];

      const ev = appendEvent(
        db,
        "batch-finalize",
        `批次 ${payload.batchNo} 提交成功（v${version}），影响探方 ${[...touchedUnits].join("、")}，相关统计标记失效`
      );
      const result = { batchNo: payload.batchNo, version, ev };
      db.idem[opId] = { at: Date.now(), result: { batchNo: result.batchNo, version: result.version } };
      return result;
    });
    publish(out.ev);
    return { batchNo: out.batchNo, version: out.version };
  });
}

export async function resolveStratum(bagNo: string, range: StratumRange, who: string): Promise<void> {
  await delay(latency());
  return withLock("hxwl10-write", async () => {
    const ev = mutate<ServerEvent>((db) => {
      const s = db.samples[bagNo];
      if (!s) throw new ServerRejectError("袋号不存在");
      if (!s.fieldStratum || !s.labStratum) throw new ServerRejectError("双方原值不齐，无法核对");
      s.resolvedRange = { ...range };
      s.resolvedBy = who;
      s.resolvedAt = Date.now();
      s.stratumStatus = "resolved";
      return appendEvent(db, "resolve", `领队核对 ${bagNo}：现场 第${s.fieldStratum.from}–${s.fieldStratum.to}层 / 实验室 第${s.labStratum.from}–${s.labStratum.to}层 → 采用第${range.from}–${range.to}层`);
    });
    publish(ev);
  });
}

export async function sealUnit(code: string): Promise<void> {
  await delay(latency());
  return withLock("hxwl10-write", async () => {
    const ev = mutate<ServerEvent>((db) => {
      const u = db.units.find((x) => x.code === code);
      if (!u) throw new ServerRejectError("探方不存在");
      u.sealed = true;
      return appendEvent(db, "seal", `探方 ${code} 通过全部封存校验，已封存`);
    });
    publish(ev);
  });
}

export function resetServer() {
  localStorage.removeItem(DB_KEY);
  const ev = { id: -1, at: Date.now(), kind: "reset", text: "服务器数据已重置为种子档案" };
  getChannel()?.postMessage({ type: "change", event: ev });
}
