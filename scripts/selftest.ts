/**
 * 业务规则自检：node --import tsx scripts/selftest.ts
 * 覆盖：
 *  A 离线登记/回连按袋号合并/地层原值冲突保留
 *  B 写入失败只重做未完成样本，重放不重复占用批次号
 *  C 两窗口并发提交同一批次只放行一份，另一份留草稿+冲突提示
 *  D 浮选结果变化 → 统计失效重算，并挡住封存
 *  E 同一袋可被两条批次认领；未回填检测挡住封存
 */
import { ServerApi, ApiError } from "../src/domain/api";
import { ClientEngine } from "../src/domain/engine";
import { isStatsStale } from "../src/domain/store";
import type { OutboxOp } from "../src/domain/types";

let passed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    console.error(`  ❌ ${name} ${detail}`);
    process.exitCode = 1;
  }
}

function enqueueSubmit(
  e: ClientEngine,
  draftId: string,
  samples: { bagNo: string; squareId: string }[],
  result: { charredSeeds: number; charcoalG: number; note: string } | null,
) {
  const now = Date.now();
  const op: OutboxOp = {
    id: `op-${now}-${Math.random().toString(36).slice(2, 6)}`,
    kind: "submit-batch",
    state: "queued",
    attempts: 0,
    finishedBagNos: [],
    payload: { draftId, origin: "field" as const, samples, result },
    createdAt: now,
    updatedAt: now,
  };
  e.data.queue = [...e.data.queue, op];
  return op;
}

console.log("\n== A. 现场离线登记，回连按袋号逐件合并；地层不一致留双方原值 ==");
{
  const api = new ServerApi();
  const e = new ClientEngine("field-A", api, false);
  check("离线状态", !e.online);
  // 现场登记：一袋与实验室一致，一袋不一致
  e.registerFieldBag("B-1001", "T0203", "第3层");
  e.registerFieldBag("B-1002", "T0203", "第三层（下文化层）");
  e.registerFieldBag("B-1003", "T0203", "第4层"); // 实验室还不知道的新袋
  check("离线时 3 条操作排队", e.data.queue.filter((o) => o.state === "queued").length === 3);
  check("离线时服务端仍只有 2 条 T0203 袋记录", api.state.bags.filter((b) => b.squareId === "T0203").length === 2);

  e.setOnline(true); // 回连自动重放
  const b1 = api.state.bags.find((b) => b.bagNo === "B-1001")!;
  const b2 = api.state.bags.find((b) => b.bagNo === "B-1002")!;
  const b3 = api.state.bags.find((b) => b.bagNo === "B-1003")!;
  check("一致袋按袋号合并到同一记录（未新建）", b1.stratum.field?.raw === "第3层" && b1.stratum.lab?.raw === "第3层");
  check("不一致袋双方原值都保留", b2.stratum.field?.raw === "第三层（下文化层）" && b2.stratum.lab?.raw === "第3层");
  check("现场新袋回连后建立", !!b3 && b3.stratum.field?.raw === "第4层");
  const conflict = api.state.conflicts.find((c) => c.bagNo === "B-1002");
  check("不一致挂起待领队核对", !!conflict && conflict.status === "pending");
  check("一致袋不产生冲突", !api.state.conflicts.some((c) => c.bagNo === "B-1001"));
  check("队列全部 done", e.data.queue.every((o) => o.state === "done"));

  const gate = api.sealGate("T0203");
  check("待核对冲突挡住封存", gate.blocked && gate.blockers.some((x) => x.includes("B-1002")));
}

console.log("\n== B. 写入失败只重做未完成样本；重放不重复占用批次号 ==");
{
  const api = new ServerApi();
  const e = new ClientEngine("field-B", api, false);
  const draftId = "FB-shared-x";
  enqueueSubmit(
    e,
    draftId,
    [
      { bagNo: "B-1001", squareId: "T0203" },
      { bagNo: "B-1002", squareId: "T0203" },
      { bagNo: "B-1003", squareId: "T0203" },
    ],
    { charredSeeds: 12, charcoalG: 1.5, note: "现场初记", },
  );
  api.armFailure(draftId, 2); // 写完 2 件后第 3 件失败一次
  e.setOnline(true); // 回连重放，命中注入故障
  const op = e.data.queue[0];

  const batchAfterFail = api.state.batches.find((b) => b.id === draftId)!;
  check("失败时批次号已分配一次", batchAfterFail.batchNo === "FX-0002", batchAfterFail.batchNo ?? "null");
  check("前两件已写入", batchAfterFail.samples.filter((s) => s.status === "written").length === 2);
  check("第三件标记失败", batchAfterFail.samples.find((s) => s.bagNo === "B-1003")?.status === "failed");
  const opAfterFail = e.data.queue.find((o) => o.id === op.id)!;
  check("操作保留已完成清单", (opAfterFail.finishedBagNos ?? []).join() === "B-1001,B-1002");
  check("操作保持 error 可续作", opAfterFail.state === "error");
  const counterAfterFail = api.state.counters.batch;

  const gateMid = api.sealGate("T0203");
  check("未回填检测挡住封存", gateMid.blocked && gateMid.blockers.some((x) => x.includes("未回填")));

  e.retryOp(op.id); // 回连重放：只补 B-1003
  const batchAfterRetry = api.state.batches.find((b) => b.id === draftId)!;
  check("重放后三件全部写入", batchAfterRetry.samples.every((s) => s.status === "written"));
  check("重放沿用原批次号", batchAfterRetry.batchNo === "FX-0002");
  check("重放没有重复发号", api.state.counters.batch === counterAfterFail);
  check("服务端只有这一条新批次（无重复占用）", api.state.batches.filter((b) => b.batchNo === "FX-0002").length === 1);
  check("队列操作转 done", e.data.queue.find((o) => o.id === op.id)?.state === "done");

  // 再次同步不应产生重复
  e.syncQueue("再次");
  check("重复同步不新增批次", api.state.batches.length === 2);
  check("重复同步不新增袋", api.state.bags.length === 4);
}

console.log("\n== C. 两窗口并发提交同一批次：只放行一份，另一份留草稿+冲突提示 ==");
{
  const api = new ServerApi();
  const a = new ClientEngine("window-A", api, false);
  const b = new ClientEngine("window-B", api, false);
  const sharedDraft = "FB-concurrent-1";
  const samples = [
    { bagNo: "B-1004", squareId: "T0204" }, // B-1004 已被实验室批次 LB-1 认领
    { bagNo: "B-1001", squareId: "T0203" },
  ];
  const result = { charredSeeds: 9, charcoalG: 0.6, note: "两窗口同编一批" };
  enqueueSubmit(a, sharedDraft, samples, result);
  enqueueSubmit(b, sharedDraft, samples, result);
  a.setOnline(true);
  b.setOnline(true);

  a.retryOp(a.data.queue[0].id);
  let threw = false;
  try {
    api.submitBatch({ draftId: sharedDraft, windowId: "direct-other", origin: "field", samples, result });
  } catch (e) {
    threw = e instanceof ApiError && e.status === 409;
  }
  check("API 层第二个窗口拿到 409", threw);

  b.retryOp(b.data.queue[0].id);
  const opB = b.data.queue[0];
  check("落败窗口操作标记 conflict", opB.state === "conflict");
  const draft = b.data.drafts[sharedDraft];
  check("落败窗口保留草稿", !!draft && draft.bagNos.join() === "B-1004,B-1001");
  check("草稿带冲突提示", !!draft.conflictNote && draft.conflictNote.includes("window-A"));
  check("服务端只放行一份批次", api.state.batches.filter((x) => x.id === sharedDraft).length === 1);
  check("批次号只发了一个", api.state.batches.filter((x) => x.batchNo === "FX-0002").length === 1);

  const b1004 = api.state.bags.find((x) => x.bagNo === "B-1004")!;
  check("同一袋被两条批次认领（实验室 LB-1 + 现场 FX-0002）", b1004.claimedBy.length === 2 && b1004.claimedBy.includes("LB-1") && b1004.claimedBy.includes(sharedDraft));
}

console.log("\n== D. 浮选结果变化：引用统计失效重算，并挡住探方封存 ==");
{
  const api = new ServerApi();
  const e = new ClientEngine("lab-edit", api, true);
  // T0204 基线：实验室批次已写完，统计已算，可封存
  check("基线 T0204 可封存", api.sealGate("T0204").blocked === false);
  const before = api.state.stats["T0204"];
  check("基线炭化种子 26", before.charredSeeds === 26);

  // 实验室修订浮选结果
  e.requestResultUpdate("LB-1", { charredSeeds: 41, note: "二漂复核更正" });
  const gateStale = api.sealGate("T0204");
  check("结果变化后封存被挡", gateStale.blocked && gateStale.warnings.some((w) => w.includes("失效")));
  check("旧统计签名已失配", isStatsStale(api.state, "T0204"));

  const sealAttempt = e.seal("T0204");
  check("强行封存返回失败", sealAttempt.ok === false && api.state.squares.find((s) => s.id === "T0204")?.sealed === false);

  const recomputed = e.recompute("T0204");
  check("重算后采用新结果（41 粒）", recomputed.charredSeeds === 41);
  check("重算后封存放行", api.sealGate("T0204").blocked === false);
  const sealed = e.seal("T0204");
  check("封存成功", sealed.ok && api.state.squares.find((s) => s.id === "T0204")?.sealed === true);

  // 再次修订：已封存探方引用的批次结果再变 → 统计又失效（封存后变更仍被检出）
  e.requestResultUpdate("LB-1", { charredSeeds: 43 });
  check("封存后结果再变仍能检出失配", api.sealGate("T0204").warnings.length > 0);
}

console.log("\n== E. 领队核对了结冲突后封存放行 ==");
{
  const api = new ServerApi();
  const field = new ClientEngine("field-C", api, true);
  const lead = new ClientEngine("lead", api, true);
  field.registerFieldBag("B-1002", "T0203", "第三层");
  check("封存被冲突挡住", api.sealGate("T0203").blocked);
  const bag = api.state.bags.find((b) => b.bagNo === "B-1002")!;
  check("双方原值仍在", bag.stratum.field?.raw === "第三层" && bag.stratum.lab?.raw === "第3层");
  lead.resolveConflict("B-1002", "第3层（以现场剖面为准，实验室录入简写）");
  field.recompute("T0203");
  check("核对+重算后封存放行", api.sealGate("T0203").blocked === false);
  check("冲突记录保留核对结论", api.state.conflicts.find((c) => c.bagNo === "B-1002")?.resolvedValue?.includes("现场剖面"));
}

console.log(`\n通过 ${passed} 项检查\n`);
if (process.exitCode) console.error("存在失败检查");
else console.log("全部通过");
