// 领域模型：探方 / 土样袋 / 浮选批次 / 离线续作队列
// 设计原则：
// 1. 现场登记与实验室结果分开记，按“袋号”逐件合并；
// 2. 地层范围双方原值都保留，不一致时挂起等领队核对，不以一方覆盖另一方；
// 3. 浮选结果变化会使引用该批次的探方统计签名失配，封存闸门随之关闭。

export type Source = "field" | "lab";

/** 地层范围，双方各自登记原串，不做归一化，避免静默改写口径 */
export interface StratumRange {
  raw: string;
  source: Source;
}

export interface Square {
  id: string; // 探方号，如 T0203
  name: string;
  sealed: boolean;
  sealedAt?: number;
}

/** 服务端土样袋：以袋号为唯一键，现场/实验室两套原值并置 */
export interface BagRecord {
  bagNo: string;
  squareId: string;
  stratum: Partial<Record<Source, StratumRange>>;
  /** 认领该袋的浮选批次（同一袋允许被两条批次认领） */
  claimedBy: string[];
  mergedAt: number;
}

/** 现场端按袋号挂接视图 */
export interface BagLink {
  bagNo: string;
  squareId: string;
  fieldStratum?: StratumRange;
  labStratum?: StratumRange;
  conflict: StratumConflict | null;
  claimedBy: string[];
  registeredByField: boolean;
  knownByLab: boolean;
}

export interface StratumConflict {
  bagNo: string;
  field: string;
  lab: string;
  status: "pending" | "resolved";
  resolvedValue?: string;
}

export type SampleStatus = "pending" | "written" | "failed";

/** 批次内一袋样本的写入状态——续作的最小重放粒度 */
export interface BatchSample {
  bagNo: string;
  squareId: string;
  status: SampleStatus;
  attempts: number;
  lastError?: string;
}

export interface FlotationResult {
  charredSeeds: number; // 炭化种子（粒）
  charcoalG: number; // 炭屑（克）
  note: string;
  version: number; // 结果修订版本，更新即 +1
  updatedAt: number;
}

export type BatchOrigin = "field" | "lab";

export interface FlotationBatch {
  id: string; // 现场批次形如 FB-uuid；实验室预置形如 LB-0001
  batchNo: string | null; // 服务端发号：FX-0001；发号前为 null
  origin: BatchOrigin;
  samples: BatchSample[];
  result: FlotationResult | null;
  status: "draft" | "submitting" | "active" | "superseded";
  ownerWindowId?: string; // 并发提交：只放行第一份
  createdAt: number;
  updatedAt: number;
}

/** 现场草稿（本地），被并发挡住的那份保留于此并挂冲突提示 */
export interface BatchDraft {
  id: string;
  bagNos: string[];
  squareId: string;
  result: FlotationResult | null;
  conflictNote?: string;
  updatedAt: number;
}

export interface SquareStats {
  squareId: string;
  bagCount: number;
  claimedBagCount: number;
  sampleCount: number;
  writtenCount: number;
  charredSeeds: number;
  charcoalG: number;
  /** 上次重算时锁定的输入签名 */
  inputSignature: string;
  recomputedAt: number;
  resultVersionAtRecompute: Record<string, number>;
}

export type OpKind = "register-bag" | "submit-batch" | "update-result";
export type OpState = "queued" | "inflight" | "done" | "error" | "conflict";

export interface OutboxOp {
  id: string;
  kind: OpKind;
  state: OpState;
  attempts: number;
  lastError?: string;
  /** 已登记成功的样本袋号——重放时据此只补未完成样本 */
  finishedBagNos?: string[];
  payload: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface SealGate {
  sealed: boolean;
  blocked: boolean;
  blockers: string[];
  warnings: string[];
}

export interface Toast {
  id: string;
  level: "info" | "success" | "warn" | "danger";
  text: string;
  at: number;
}
