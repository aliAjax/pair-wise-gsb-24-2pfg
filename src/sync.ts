// 纯领域逻辑：探方统计、失效哈希、封存闸门、三方记录串联
import type { ServerBatch, ServerSample, Snapshot, StratumRange } from "./types";

export interface UnitStat {
  unitCode: string;
  bagCount: number;
  claimedBags: number;
  pendingBags: number;
  conflictBags: number;
  doneResults: number;
  charredG: number;
  seeds: number;
}

/** 引用该批次的探方统计所依赖的全部原始量；任何一项变化哈希即变 */
function djb2(parts: string[]): string {
  const s = parts.join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export function unitBags(snap: Snapshot, unitCode: string): ServerSample[] {
  return Object.values(snap.samples)
    .filter((s) => s.unitCode === unitCode)
    .sort((a, b) => a.bagNo.localeCompare(b.bagNo));
}

/**
 * 浮选结果变化 → 引用该批次的探方统计失效。
 * 哈希输入包含：每袋的认领批次、每条结果的重量/种子/状态、地层冲突状态。
 */
export function computeStat(snap: Snapshot, unitCode: string): UnitStat {
  const bags = unitBags(snap, unitCode);
  let claimedBags = 0;
  let pendingBags = 0;
  let conflictBags = 0;
  let doneResults = 0;
  let charredG = 0;
  let seeds = 0;

  for (const bag of bags) {
    if (bag.batchNos.length) claimedBags += 1;
    if (bag.stratumStatus === "conflict") conflictBags += 1;
    let hasPending = false;
    for (const bn of bag.batchNos) {
      const batch: ServerBatch | undefined = snap.batches[bn];
      const res = batch?.results[bag.bagNo];
      if (!res) continue;
      if (res.status === "pending") hasPending = true;
      else {
        doneResults += 1;
        charredG += res.charredG;
        seeds += res.seeds;
      }
    }
    if (hasPending) pendingBags += 1;
  }

  return { unitCode, bagCount: bags.length, claimedBags, pendingBags, conflictBags, doneResults, charredG, seeds };
}

export function statHash(snap: Snapshot, unitCode: string): string {
  const bags = unitBags(snap, unitCode);
  const parts: string[] = [];
  for (const bag of bags) {
    parts.push(bag.bagNo, bag.stratumStatus, bag.batchNos.slice().sort().join(","));
    for (const bn of bag.batchNos.slice().sort()) {
      const res = snap.batches[bn]?.results[bag.bagNo];
      if (res) parts.push(String(res.status), String(res.charredG), String(res.seeds));
    }
  }
  return djb2(parts);
}

export interface RecalcMark {
  hash: string;
  at: number;
}

const STATS_KEY = "hxwl10.stats.v1";

export function loadMarks(): Record<string, RecalcMark> {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY) || "{}") as Record<string, RecalcMark>;
  } catch {
    return {};
  }
}

export function saveMarks(marks: Record<string, RecalcMark>) {
  localStorage.setItem(STATS_KEY, JSON.stringify(marks));
}

/** 封存闸门：任何一项不过都挡住探方封存 */
export function sealBlockers(
  snap: Snapshot,
  unitCode: string,
  marks: Record<string, RecalcMark>
): string[] {
  const blockers: string[] = [];
  const stat = computeStat(snap, unitCode);
  if (stat.pendingBags > 0) blockers.push(`还有 ${stat.pendingBags} 袋浮选检测未回填结果`);
  if (stat.conflictBags > 0) blockers.push(`${stat.conflictBags} 袋现场/实验室地层范围不一致，待领队核对`);
  const mark = marks[unitCode];
  if (!mark || mark.hash !== statHash(snap, unitCode)) blockers.push("引用的浮选结果有变化，统计已失效，需重算");
  return blockers;
}

export function rangeText(r: StratumRange | null | undefined): string {
  if (!r) return "—";
  return r.from === r.to ? `第${r.from}层` : `第${r.from}–${r.to}层`;
}

export const stratumStatusText: Record<ServerSample["stratumStatus"], string> = {
  unilateral: "单方数据",
  agree: "双方一致",
  conflict: "不一致 · 待领队核对",
  resolved: "领队已核对",
};

export function formatTime(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
