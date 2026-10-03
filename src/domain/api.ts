import {
  canSeal,
  claimBag,
  createInitialState,
  evaluateSealGate,
  findBag,
  findBatch,
  nextBatchNo,
  recomputeStats,
  upsertBagStratum,
  type ServerStateData,
} from "./store";
import type {
  BatchSample,
  FlotationBatch,
  FlotationResult,
  SealGate,
  SquareStats,
  StratumConflict,
} from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: unknown,
  ) {
    super(message);
  }
}

interface SubmitReq {
  draftId: string; // 现场批次草稿 id：两个窗口的同一批次共用它
  windowId: string;
  origin: "field" | "lab";
  samples: { bagNo: string; squareId: string }[];
  result?: FlotationResult | null;
  /** 已完成样本：重放只补未完成件，且不重新发号 */
  finishedBagNos?: string[];
}

interface SubmitOk {
  batch: FlotationBatch;
  written: string[];
  completed: boolean;
  staleSquareIds: string[];
}

/**
 * 模拟服务端：
 * - 批次号只在“建批+发号”同一临界区内分配一次，重放沿用原号；
 * - draftId 上的窗口锁实现同一批次并发提交只放行第一份；
 * - failPlan 让某批写入到第 N 件后失败一次（故障注入，用于演示续作）。
 */
export class ServerApi {
  state: ServerStateData;
  private locks = new Map<string, { windowId: string; batchId: string }>();
  private failPlan = new Map<string, number>(); // draftId -> 写完 N 件后下一件失败

  constructor() {
    this.state = createInitialState();
    this.seed();
  }

  private seed(now = Date.parse("2026-10-03T08:00:00")) {
    const s = this.state;
    s.squares.push(
      { id: "T0203", name: "T0203 探方", sealed: false },
      { id: "T0204", name: "T0204 探方", sealed: false },
    );
    // 实验室侧已有的袋登记与一条实验室批次
    upsertBagStratum(s, { bagNo: "B-1001", squareId: "T0203", raw: "第3层", source: "lab" }, now);
    upsertBagStratum(
      s,
      { bagNo: "B-1002", squareId: "T0203", raw: "第3层", source: "lab" },
      now,
    );
    upsertBagStratum(
      s,
      { bagNo: "B-1004", squareId: "T0204", raw: "H12灰坑", source: "lab" },
      now,
    );
    const labSamples: BatchSample[] = [
      { bagNo: "B-1004", squareId: "T0204", status: "written", attempts: 1 },
    ];
    const labBatch: FlotationBatch = {
      id: "LB-1",
      batchNo: "FX-0001",
      origin: "lab",
      samples: labSamples,
      result: { charredSeeds: 26, charcoalG: 3.4, note: "实验室初漂", version: 1, updatedAt: now },
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    s.batches.push(labBatch);
    claimBag(s, "B-1004", labBatch.id);
    s.counters.batch = 1;
    for (const sq of ["T0203", "T0204"]) recomputeStats(s, sq, now);
  }

  /** 故障注入：draftId 这批在已写入 n 件后，下一件失败一次 */
  armFailure(draftId: string, failAfter: number) {
    this.failPlan.set(draftId, failAfter);
  }

  snapshot(): ServerStateData {
    return structuredClone(this.state);
  }

  registerBag(req: { bagNo: string; squareId: string; stratumRaw: string; source: "field" | "lab" }) {
    const now = Date.now();
    const { bag, conflicted } = upsertBagStratum(
      this.state,
      { bagNo: req.bagNo, squareId: req.squareId, raw: req.stratumRaw, source: req.source },
      now,
    );
    return { bag: structuredClone(bag), conflicted };
  }

  submitBatch(req: SubmitReq): SubmitOk {
    // 1) 并发闸：同一 draftId 只放行第一个窗口
    const lock = this.locks.get(req.draftId);
    if (lock && lock.windowId !== req.windowId) {
      throw new ApiError(
        409,
        `批次已由另一窗口 ${lock.windowId} 提交并占用批次号，此份保留草稿`,
        { winnerBatchId: lock.batchId, winnerWindowId: lock.windowId },
      );
    }

    const finished = new Set(req.finishedBagNos ?? []);
    let batch = findBatch(this.state, req.draftId);

    // 2) 首次提交：建批与发号在同一临界区内完成；重放走同一记录，绝不重新发号
    if (!batch) {
      const batchNo = nextBatchNo(this.state);
      batch = {
        id: req.draftId,
        batchNo,
        origin: req.origin,
        samples: req.samples.map((s) => ({
          bagNo: s.bagNo,
          squareId: s.squareId,
          status: "pending" as const,
          attempts: 0,
        })),
        result: req.result ? structuredClone(req.result) : null,
        status: "submitting",
        ownerWindowId: req.windowId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.state.batches.push(batch);
      this.locks.set(req.draftId, { windowId: req.windowId, batchId: batch.id });
    }

    // 3) 逐袋写入：已完成的（服务端已 written 或客户端 finished 清单）跳过
    const written: string[] = [];
    for (const sample of batch.samples) {
      if (sample.status === "written" || finished.has(sample.bagNo)) {
        if (sample.status !== "written") sample.status = "written";
        written.push(sample.bagNo);
        continue;
      }
      sample.attempts += 1;
      const failAfter = this.failPlan.get(req.draftId);
      if (failAfter !== undefined && written.length >= failAfter) {
        sample.status = "failed";
        sample.lastError = `服务端写入第 ${sample.attempts} 次尝试失败（袋 ${sample.bagNo}）`;
        batch.updatedAt = Date.now();
        this.failPlan.delete(req.draftId); // 故障只注入一次，重放应能走完
        throw new ApiError(500, `样本 ${sample.bagNo} 写入失败，已完成 ${written.length} 件`, {
          batchId: batch.id,
          batchNo: batch.batchNo,
          finishedBagNos: written,
        });
      }
      // 正常写入：登记袋归属、认领关系
      const incoming = req.samples.find((s) => s.bagNo === sample.bagNo);
      if (incoming) {
        if (!findBag(this.state, sample.bagNo)) {
          upsertBagStratum(
            this.state,
            {
              bagNo: sample.bagNo,
              squareId: sample.squareId,
              raw: "地层待补",
              source: "lab",
            },
            Date.now(),
          );
        }
        claimBag(this.state, sample.bagNo, batch.id);
      }
      sample.status = "written";
      sample.lastError = undefined;
      written.push(sample.bagNo);
    }

    batch.status = "active";
    batch.updatedAt = Date.now();
    const staleSquareIds = [...new Set(batch.samples.map((s) => s.squareId))];
    return {
      batch: structuredClone(batch),
      written,
      completed: true,
      staleSquareIds,
    };
  }

  /** 实验室修订结果：版本 +1，引用该批次的探方统计签名随即失配 */
  updateResult(batchId: string, patch: Partial<Omit<FlotationResult, "version">>): {
    batch: FlotationBatch;
    staleSquareIds: string[];
  } {
    const batch = findBatch(this.state, batchId);
    if (!batch) throw new ApiError(404, `批次 ${batchId} 不存在`);
    const prev = batch.result ?? { charredSeeds: 0, charcoalG: 0, note: "", version: 0 };
    batch.result = {
      charredSeeds: patch.charredSeeds ?? prev.charredSeeds,
      charcoalG: patch.charcoalG ?? prev.charcoalG,
      note: patch.note ?? prev.note,
      version: prev.version + 1,
      updatedAt: Date.now(),
    };
    batch.updatedAt = Date.now();
    return {
      batch: structuredClone(batch),
      staleSquareIds: [...new Set(batch.samples.map((s) => s.squareId))],
    };
  }

  recompute(squareId: string): SquareStats {
    return recomputeStats(this.state, squareId, Date.now());
  }

  sealGate(squareId: string): SealGate {
    return evaluateSealGate(this.state, squareId);
  }

  sealSquare(squareId: string): { ok: boolean; gate: SealGate } {
    const gate = evaluateSealGate(this.state, squareId);
    if (!canSeal(this.state, squareId)) return { ok: false, gate };
    const sq = this.state.squares.find((s) => s.id === squareId);
    if (sq) {
      sq.sealed = true;
      sq.sealedAt = Date.now();
    }
    return { ok: true, gate: evaluateSealGate(this.state, squareId) };
  }

  /** 领队核对：以确认值了结冲突（双方原值仍保留在袋上） */
  resolveConflict(bagNo: string, resolvedValue: string): StratumConflict {
    const c = this.state.conflicts.find((x) => x.bagNo === bagNo);
    if (!c) throw new ApiError(404, `袋 ${bagNo} 无待核冲突`);
    c.status = "resolved";
    c.resolvedValue = resolvedValue;
    return structuredClone(c);
  }
}
