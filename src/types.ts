// 领域模型：探方 — 土样（袋） — 浮选批次
// 一袋土样可以被多条浮选批次认领（N:N）

export interface StratumRange {
  from: number;
  to: number;
}

export interface Unit {
  code: string; // 探方号，如 T0203
  name: string;
  sealed: boolean;
}

export type ResultStatus = "pending" | "done";

/** 浮选结果：逐袋记录 */
export interface FlotResult {
  bagNo: string;
  charredG: number; // 炭化遗物重量 g
  seeds: number; // 炭化植物种子数
  status: ResultStatus; // pending = 还没回填的检测
  note?: string;
}

export type StratumStatus = "unilateral" | "agree" | "conflict" | "resolved";

export interface ServerSample {
  bagNo: string; // 袋号，合并主键
  unitCode: string;
  // 现场原值与实验室原值分别保留，不一致时两边都不覆盖
  fieldStratum: StratumRange | null;
  labStratum: StratumRange | null;
  labStratumBatchNo?: string;
  stratumStatus: StratumStatus;
  resolvedRange?: StratumRange;
  resolvedBy?: string;
  resolvedAt?: number;
  batchNos: string[]; // 认领该袋的浮选批次（N:N 并集）
  soilColor?: string;
  weightKg?: number;
  registeredAt: number;
  updatedAt: number;
}

export interface ServerBatch {
  batchNo: string;
  labCode: string;
  version: number; // 乐观锁版本，0 = 草稿暂存
  submittedAt: number | null;
  bagNos: string[];
  results: Record<string, FlotResult>;
}

export interface ServerEvent {
  id: number;
  at: number;
  kind: string;
  text: string;
}

export interface IdemRecord {
  at: number;
  result: unknown;
}

export interface BatchStageRow {
  /** 哪些操作已把该袋写入暂存：多个竞争窗口各记各的 checkpoint */
  writtenBy: string[];
  lab: StratumRange;
  result: FlotResult;
}

export interface BatchStage {
  batchNo: string;
  baseVersion: number;
  rows: Record<string, BatchStageRow>;
}

export interface ServerDB {
  units: Unit[];
  samples: Record<string, ServerSample>;
  batches: Record<string, ServerBatch>;
  stage: Record<string, BatchStage>; // 逐袋写入的暂存区（故障断点）
  alloc: Record<string, string>; // 幂等键 → 已占用批次号
  counter: number;
  idem: Record<string, IdemRecord>; // 幂等表：重放不重复写入/占用
  seq: number;
  events: ServerEvent[];
}

export interface Snapshot {
  units: Unit[];
  samples: Record<string, ServerSample>;
  batches: Record<string, ServerBatch>;
  idemCount: number;
}

// ---- 客户端 outbox / 草稿 ----

export interface FieldReg {
  bagNo: string;
  unitCode: string;
  stratum: StratumRange;
  soilColor?: string;
  weightKg?: number;
}

export interface BatchRowDraft {
  bagNo: string;
  lab: StratumRange; // 实验室认定的地层范围
  charredG: number;
  seeds: number;
  status: ResultStatus;
  note?: string;
}

export interface BatchPayload {
  batchNo: string;
  labCode: string;
  baseVersion: number; // 编辑时所依据的版本，提交时做 CAS
  rows: BatchRowDraft[];
}

export interface DraftConflict {
  serverVersion: number;
  at: number;
}

export interface DraftState {
  payload: BatchPayload;
  conflict?: DraftConflict;
}

export type OpStatus = "waiting" | "running" | "done" | "error" | "conflict";

export interface OpLogLine {
  at: number;
  text: string;
}

export interface OutboxOp {
  id: string;
  kind: "field-register" | "batch-submit";
  clientId: string;
  createdAt: number;
  status: OpStatus;
  attempts: number;
  completedBags: string[]; // 已写入的袋：断点续跑只补剩下的
  message?: string;
  field?: FieldReg;
  batch?: BatchPayload;
  logs: OpLogLine[];
}

export interface LocalLogLine {
  id: string;
  at: number;
  kind: string;
  text: string;
}
