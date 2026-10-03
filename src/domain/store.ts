import type {
  BagRecord,
  BatchDraft,
  FlotationBatch,
  FlotationResult,
  OutboxOp,
  SealGate,
  Square,
  SquareStats,
  StratumConflict,
} from "./types";

/** 纯内存状态：ServerApi（服务端）与 ClientStore（现场端）共用同一套归并规则 */
export interface ServerStateData {
  squares: Square[];
  bags: BagRecord[];
  batches: FlotationBatch[];
  conflicts: StratumConflict[];
  stats: Record<string, SquareStats>;
  counters: { batch: number };
}

export function createInitialState(): ServerStateData {
  return { squares: [], bags: [], batches: [], conflicts: [], stats: {}, counters: { batch: 0 } };
}

export function findBag(state: ServerStateData, bagNo: string): BagRecord | undefined {
  return state.bags.find((b) => b.bagNo === bagNo);
}

export function findBatch(state: ServerStateData, id: string): FlotationBatch | undefined {
  return state.batches.find((b) => b.id === id);
}

export function findConflict(
  state: ServerStateData,
  bagNo: string,
): StratumConflict | undefined {
  return state.conflicts.find((c) => c.bagNo === bagNo);
}

function normalizeStratum(raw: string): string {
  return raw.trim().replace(/\s+/g, "");
}

/** 现场/实验室原值并置；不一致则登记冲突，双方原值都留，等领队核对 */
export function upsertBagStratum(
  state: ServerStateData,
  input: { bagNo: string; squareId: string; raw: string; source: "field" | "lab" },
  now: number,
): { bag: BagRecord; conflicted: boolean } {
  let bag = findBag(state, input.bagNo);
  if (!bag) {
    bag = {
      bagNo: input.bagNo,
      squareId: input.squareId,
      stratum: {},
      claimedBy: [],
      mergedAt: now,
    };
    state.bags.push(bag);
  } else if (!bag.squareId && input.squareId) {
    bag.squareId = input.squareId;
  }
  bag.stratum[input.source] = { raw: input.raw, source: input.source };

  const f = bag.stratum.field?.raw;
  const l = bag.stratum.lab?.raw;
  let conflicted = false;
  if (f !== undefined && l !== undefined) {
    conflicted = normalizeStratum(f) !== normalizeStratum(l);
    const existing = findConflict(state, input.bagNo);
    if (conflicted && !existing) {
      state.conflicts.push({
        bagNo: input.bagNo,
        field: f,
        lab: l,
        status: "pending",
      });
    }
    if (!conflicted && existing && existing.status === "pending") {
      state.conflicts = state.conflicts.filter((c) => c.bagNo !== input.bagNo);
    }
    if (existing) {
      existing.field = f;
      existing.lab = l;
      existing.status = conflicted ? existing.status : "resolved";
    }
  }
  return { bag, conflicted };
}

export function linkBag(bag: BagRecord, conflict: StratumConflict | undefined) {
  return {
    bagNo: bag.bagNo,
    squareId: bag.squareId,
    fieldStratum: bag.stratum.field,
    labStratum: bag.stratum.lab,
    conflict: conflict ?? null,
    claimedBy: [...bag.claimedBy],
    registeredByField: bag.stratum.field !== undefined,
    knownByLab: bag.stratum.lab !== undefined,
  };
}

/** 同一袋允许被两条批次认领：只去重，不拒绝第二次认领 */
export function claimBag(state: ServerStateData, bagNo: string, batchId: string): void {
  const bag = findBag(state, bagNo);
  if (bag && !bag.claimedBy.includes(batchId)) bag.claimedBy.push(batchId);
}

export function nextBatchNo(state: ServerStateData): string {
  state.counters.batch += 1;
  return `FX-${String(state.counters.batch).padStart(4, "0")}`;
}

// ---- 统计：签名驱动失效 ------------------------------------------------

function activeBatches(state: ServerStateData): FlotationBatch[] {
  return state.batches.filter((b) => b.status !== "superseded");
}

/** 探方统计的全部输入：袋、认领关系、有效批次的样本与结果版本 */
export function statsSignature(state: ServerStateData, squareId: string): string {
  const bagKeys = state.bags
    .filter((b) => b.squareId === squareId)
    .map(
      (b) =>
        `${b.bagNo}:f=${b.stratum.field?.raw ?? ""}|l=${b.stratum.lab?.raw ?? ""}|c=${[...b.claimedBy].sort().join(">")}`,
    )
    .sort();
  const batchKeys = activeBatches(state)
    .filter((b) => b.samples.some((s) => s.squareId === squareId))
    .map((b) => {
      const samples = b.samples
        .filter((s) => s.squareId === squareId)
        .map((s) => `${s.bagNo}:${s.status}`)
        .sort()
        .join(",");
      return `${b.id}:v=${b.result?.version ?? 0}:r=${JSON.stringify(b.result ?? null)}:${samples}`;
    })
    .sort();
  return `${squareId}::${bagKeys.join(";;")}::${batchKeys.join(";;")}`;
}

export function isStatsStale(state: ServerStateData, squareId: string): boolean {
  const stats = state.stats[squareId];
  if (!stats) return true;
  return stats.inputSignature !== statsSignature(state, squareId);
}

/** 全量重算探方统计（结果变化 → 签名失配 → 这里重算并换签） */
export function recomputeStats(state: ServerStateData, squareId: string, now: number): SquareStats {
  const bags = state.bags.filter((b) => b.squareId === squareId);
  const batches = activeBatches(state).filter((b) =>
    b.samples.some((s) => s.squareId === squareId),
  );
  let charredSeeds = 0;
  let charcoalG = 0;
  let sampleCount = 0;
  let writtenCount = 0;
  for (const b of batches) {
    const inSquare = b.samples.filter((s) => s.squareId === squareId);
    sampleCount += inSquare.length;
    writtenCount += inSquare.filter((s) => s.status === "written").length;
    // 批次结果按探方内样本数占比分摊归属（一袋只可能属于一个探方，这里即全值/按袋）
    if (b.result) {
      const share = b.samples.length ? inSquare.length / b.samples.length : 0;
      charredSeeds += Math.round(b.result.charredSeeds * share);
      charcoalG += Math.round(b.result.charcoalG * share * 100) / 100;
    }
  }
  const stats: SquareStats = {
    squareId,
    bagCount: bags.length,
    claimedBagCount: bags.filter((b) => b.claimedBy.length > 0).length,
    sampleCount,
    writtenCount,
    charredSeeds,
    charcoalG,
    inputSignature: statsSignature(state, squareId),
    recomputedAt: now,
    resultVersionAtRecompute: Object.fromEntries(
      batches.map((b) => [b.id, b.result?.version ?? 0]),
    ),
  };
  state.stats[squareId] = stats;
  return stats;
}

/** 封存闸门：未回填检测（未写完样本）、未核对地层冲突、统计失配，任一挡住封存 */
export function evaluateSealGate(state: ServerStateData, squareId: string): SealGate {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const pendingConflicts = state.conflicts.filter(
    (c) => c.status === "pending" && state.bags.find((b) => b.bagNo === c.bagNo)?.squareId === squareId,
  );
  if (pendingConflicts.length > 0) {
    blockers.push(
      `地层原值不一致待领队核对：${pendingConflicts.map((c) => c.bagNo).join("、")}`,
    );
  }

  const unfinished = activeBatches(state).flatMap((b) =>
    b.samples
      .filter((s) => s.squareId === squareId && s.status !== "written")
      .map((s) => ({ batch: b.batchNo ?? b.id, bagNo: s.bagNo, status: s.status })),
  );
  if (unfinished.length > 0) {
    blockers.push(
      `探方封存时仍有未回填检测 ${unfinished.length} 件：` +
        unfinished.map((u) => `${u.bagNo}(${u.status})`).join("、"),
    );
  }

  if (isStatsStale(state, squareId)) {
    warnings.push("浮选结果已变化，引用统计失效，需重算后才能封存");
  }

  const square = state.squares.find((s) => s.id === squareId);
  return {
    sealed: square?.sealed ?? false,
    blocked: blockers.length > 0 || isStatsStale(state, squareId),
    blockers,
    warnings,
  };
}

export function canSeal(state: ServerStateData, squareId: string): boolean {
  return !evaluateSealGate(state, squareId).blocked;
}

// ---- 现场端本地视图状态 ------------------------------------------------

export interface ClientData {
  windowId: string;
  online: boolean;
  server: ServerStateData | null;
  queue: OutboxOp[];
  drafts: Record<string, BatchDraft>;
  /** 以袋号为键的现场离线登记 */
  fieldBags: Record<string, { bagNo: string; squareId: string; stratumRaw: string; at: number }>;
  /** 现场发起的批次草稿（提交前） */
  batchComposer: { bagNos: string[]; squareId: string; result: FlotationResult | null };
  statsStale: Record<string, boolean>;
  toasts: { id: string; level: "info" | "success" | "warn" | "danger"; text: string; at: number }[];
}

export function draftForBatch(drafts: Record<string, BatchDraft>, batchId: string) {
  return drafts[batchId];
}
