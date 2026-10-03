// Node 冒烟测试：给浏览器 API 打垫片，直接驱动 server.ts / sync.ts 的真实逻辑
class MemStorage {
  m = new Map();
  getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null;
  }
  setItem(k, v) {
    this.m.set(k, String(v));
  }
  removeItem(k) {
    this.m.delete(k);
  }
}
globalThis.localStorage = new MemStorage();
globalThis.sessionStorage = new MemStorage();
class BC {
  postMessage() {}
  addEventListener() {}
  removeEventListener() {}
}
globalThis.BroadcastChannel = BC;
globalThis.navigator = { locks: undefined }; // 强制走进程内链式锁降级路径
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const assert = (cond, msg) => {
  if (!cond) {
    console.error("❌ FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("✅", msg);
  }
};

const server = await import("/tmp/hxwl-server.mjs");
const sync = await import("/tmp/hxwl-sync.mjs");

// ---------- 场景1：两窗口同批次并发提交，只放行一份 ----------
{
  const snap0 = await server.loadSnapshot();
  const base = snap0.batches["B-001"].version; // v3
  const rows = snap0.batches["B-001"].bagNos.map((bag) => {
    const r = snap0.batches["B-001"].results[bag];
    return { bagNo: bag, lab: { from: 4, to: 4 }, charredG: r.charredG, seeds: r.seeds, status: r.status };
  });
  const payloadA = { batchNo: "B-001", labCode: "浮选室甲", baseVersion: base, rows };
  const payloadB = {
    batchNo: "B-001",
    labCode: "浮选室甲",
    baseVersion: base,
    rows: rows.map((r) => (r.bagNo === "S-1001" ? { ...r, charredG: 9.9, seeds: 99 } : r)),
  };

  const opA = "OP-A", opB = "OP-B";
  for (const r of payloadA.rows) await server.writeBatchRow(opA, payloadA, r.bagNo);
  for (const r of payloadB.rows) await server.writeBatchRow(opB, payloadB, r.bagNo);

  const [ra, rb] = await Promise.allSettled([
    server.finalizeBatch(opA, payloadA),
    server.finalizeBatch(opB, payloadB),
  ]);
  const winnerRes = ra.status === "fulfilled" ? ra.value : rb.status === "fulfilled" ? rb.value : null;
  const lostRes = ra.status === "rejected" ? ra : rb;
  const winnerOp = ra.status === "fulfilled" ? opA : opB;
  const loserOp = winnerOp === opA ? opB : opA;
  const loserPayload = winnerOp === opA ? payloadB : payloadA;
  assert(winnerRes !== null, "并发提交：恰好一份放行");
  assert(lostRes.status === "rejected" && lostRes.reason.name === "ConflictError", "另一份收到 ConflictError 被拒");
  const snap1 = await server.loadSnapshot();
  assert(snap1.batches["B-001"].version === base + 1, `批次只升一个版本 v${snap1.batches["B-001"].version}（应为 v${base + 1}）`);

  // 败者以新版本续传：先逐袋重写（新版本基底），再 finalize，再升一版
  const retryPayload = { ...loserPayload, baseVersion: winnerRes.version };
  for (const r of retryPayload.rows) await server.writeBatchRow(loserOp, retryPayload, r.bagNo);
  const finB = await server.finalizeBatch(loserOp, retryPayload);
  assert(finB.version === base + 2, `败者续传成功：v${finB.version}（应为 v${base + 2}）`);
  const claimedByTwo = (await server.loadSnapshot()).samples["S-1002"].batchNos;
  assert(
    claimedByTwo.includes("B-001") && claimedByTwo.includes("B-003"),
    `S-1002 仍被两批次认领：${claimedByTwo.join("、")}`
  );
}

// ---------- 场景2：逐袋写入故障，重放只补未完成袋 + 幂等不重复 ----------
{
  server.resetServer();
  const snap0 = await server.loadSnapshot();
  const opId = "OP-FLAKY";
  server.injectFailures(opId, 2); // 前两次调用必失败
  const rows = ["S-1001", "S-1002"].map((bag) => ({
    bagNo: bag,
    lab: { from: 4, to: 4 },
    charredG: 1,
    seeds: 1,
    status: "done",
  }));
  const payload = { batchNo: "B-009", labCode: "故障演练", baseVersion: 0, rows };

  let failedAt = "";
  for (const r of rows) {
    try {
      await server.writeBatchRow(opId, payload, r.bagNo);
    } catch (e) {
      failedAt = r.bagNo;
      break;
    }
  }
  assert(failedAt === "S-1001", "第一次写入 S-1001 即被注入故障打断");

  // 第二次尝试：服务端计数仍为 0，没有任何半成品批次号/暂存越界
  const before = await server.loadSnapshot();
  assert(before.batches["B-009"] === undefined, "失败后未产生批次提交");

  let failed2 = false;
  for (const r of rows) {
    try {
      await server.writeBatchRow(opId, payload, r.bagNo);
    } catch {
      failed2 = true;
      break;
    }
  }
  assert(failed2, "第二次尝试（S-1001 重放）再次故障，S-1001 未被记为完成");

  // 第三次：故障耗尽，S-1001 写入，S-1002 写入，提交
  for (const r of rows) await server.writeBatchRow(opId, payload, r.bagNo);
  const fin = await server.finalizeBatch(opId, payload);
  assert(fin.batchNo === "B-009" && fin.version === 1, "断点续跑后提交成功 B-009 v1");

  // 完全重放整条 op：finalize 命中幂等表，版本不变
  for (const r of rows) await server.writeBatchRow(opId, payload, r.bagNo); // 已写袋跳过
  const replay = await server.finalizeBatch(opId, payload);
  assert(replay.version === 1, "整条重放命中幂等表，不产生新版本/不重复写入");
  const after = await server.loadSnapshot();
  assert(after.batches["B-009"].version === 1, "批次版本保持 v1");
}

// ---------- 场景3：批次号占用幂等 ----------
{
  const n1 = await server.allocateBatchNo("OP-ALLOC-1");
  const n2 = await server.allocateBatchNo("OP-ALLOC-1");
  const n3 = await server.allocateBatchNo("OP-ALLOC-2");
  assert(n1 === n2, `同一 op 重放取回同一批次号 ${n1}`);
  assert(n3 !== n1, `不同 op 取得新号 ${n3} ≠ ${n1}`);
  server.injectFailures("OP-ALLOC-3", 1);
  let threw = false;
  try {
    await server.allocateBatchNo("OP-ALLOC-3");
  } catch {
    threw = true;
  }
  assert(threw, "占用批次号时遇网络故障：未占用");
  const n4 = await server.allocateBatchNo("OP-ALLOC-3");
  const n5 = await server.allocateBatchNo("OP-ALLOC-4");
  assert(n4 !== n5, "故障前未占用，恢复后新 op 拿到的是全新号，无重号空洞冲突");
}

// ---------- 场景4：按袋号合并，双方原值保留，冲突状态 ----------
{
  const snap0 = await server.loadSnapshot();
  const beforeLab = snap0.samples["S-1001"].labStratum; // 第4层
  // 现场重复登记 S-1001，给不同现场值：原值必须保留
  await server.registerField("OP-F1", {
    bagNo: "S-1001",
    unitCode: "T0203",
    stratum: { from: 9, to: 9 },
    soilColor: "灰褐土",
  });
  const s1 = (await server.loadSnapshot()).samples["S-1001"];
  assert(s1.fieldStratum.from === 3 && s1.fieldStratum.to === 3, "重复登记不覆盖现场原值（仍为第3层）");
  assert(s1.labStratum.from === beforeLab.from && s1.labStratum.to === beforeLab.to, "实验室原值未受影响（第4层）");
  assert(s1.stratumStatus === "conflict", "双方不一致 → conflict 待领队核对");

  // 全新袋号：新建
  const res = await server.registerField("OP-F2", {
    bagNo: "S-9001",
    unitCode: "T0301",
    stratum: { from: 7, to: 8 },
  });
  assert(res.merged === false, "新袋号 S-9001 新建，不误合并");

  // 重放 OP-F2：命中幂等，返回首次缓存结果，不产生第二条
  const res2 = await server.registerField("OP-F2", {
    bagNo: "S-9001",
    unitCode: "T0301",
    stratum: { from: 7, to: 8 },
  });
  assert(res2.merged === false, "同 op 重放命中幂等表：返回首次结果，不重复执行合并逻辑");
  const snap = await server.loadSnapshot();
  assert(Object.keys(snap.samples).filter((k) => k === "S-9001").length === 1, "S-9001 只有一条记录");
}

// ---------- 场景5：统计失效与封存闸门 ----------
{
  let snap = await server.loadSnapshot();
  // 初始无重算标记 → 全部探方统计失效
  let blockers = sync.sealBlockers(snap, "T0203", {});
  assert(blockers.some((b) => b.includes("统计已失效")), "无重算标记时封存被挡：统计失效");
  assert(blockers.some((b) => b.includes("未回填")), "T0203 有未回填检测 → 封存被挡");
  assert(blockers.some((b) => b.includes("待领队核对")), "T0203 有地层冲突 → 封存被挡");

  const h0 = sync.statHash(snap, "T0204");
  // 改 B-001 中 S-2001 的结果（T0204 引用它）→ 哈希变化
  const b1 = snap.batches["B-001"];
  const op = "OP-CHANGE";
  const payload = {
    batchNo: "B-001",
    labCode: b1.labCode,
    baseVersion: b1.version,
    rows: b1.bagNos.map((bag) => {
      const r = b1.results[bag];
      return bag === "S-2001"
        ? { bagNo: bag, lab: { from: 2, to: 3 }, charredG: 5.5, seeds: 40, status: "done" }
        : { bagNo: bag, lab: { from: 4, to: 4 }, charredG: r.charredG, seeds: r.seeds, status: r.status, ...(r.note ? { note: r.note } : {}) };
    }),
  };
  for (const r of payload.rows) await server.writeBatchRow(op, payload, r.bagNo);
  await server.finalizeBatch(op, payload);
  snap = await server.loadSnapshot();
  const h1 = sync.statHash(snap, "T0204");
  assert(h0 !== h1, "浮选结果变化：T0204 统计指纹改变（旧标记失效）");

  const marks = { T0204: { hash: h0, at: 0 } };
  assert(sync.sealBlockers(snap, "T0204", marks).some((b) => b.includes("统计已失效")), "旧指纹不匹配 → 必须重算才能封存");
  const fresh = { T0204: { hash: h1, at: Date.now() } };
  const left = sync.sealBlockers(snap, "T0204", fresh);
  assert(left.some((b) => b.includes("待领队核对")) && !left.some((b) => b.includes("统计")), "重算后只剩地层冲突拦截项");

  // 全部解除：用一个干净探方验证可封存路径（T0204 冲突由领队核对+重算后）
  await server.resolveStratum("S-2001", { from: 2, to: 3 });
  snap = await server.loadSnapshot();
  const h2 = sync.statHash(snap, "T0204");
  const marks2 = { T0204: { hash: h2, at: Date.now() } };
  const finalBlockers = sync.sealBlockers(snap, "T0204", marks2);
  assert(finalBlockers.length === 0, `冲突核对+重算后 T0204 无拦截（剩余：${finalBlockers.join("；") || "无"}）`);
  await server.sealUnit("T0204");
  const sealed = (await server.loadSnapshot()).units.find((u) => u.code === "T0204").sealed;
  assert(sealed, "T0204 封存成功");
}

console.log(process.exitCode ? "\n存在失败用例" : "\n全部冒烟用例通过");
