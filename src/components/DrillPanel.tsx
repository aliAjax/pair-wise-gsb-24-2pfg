// 双窗口并发演练：两个独立"客户端"各自编辑同一批次，同时点提交，只放行一份。
// 底层就是真正的服务器 API（localStorage 跨标签页共享），所以开两个浏览器窗口效果完全一样。
import { useEffect, useRef, useState } from "react";
import { ConflictError, injectFailures, loadSnapshot, writeBatchRow, finalizeBatch } from "../server";
import type { BatchPayload, BatchRowDraft, Snapshot } from "../types";

interface Side {
  client: string;
  charredG: string;
  seeds: string;
  status: "idle" | "writing" | "submitting" | "won" | "lost" | "error";
  logs: string[];
  progress: number;
}

const TARGET_BATCH = "B-001";
const TARGET_BAG = "S-1001";

function freshSide(client: string, snap: Snapshot): Side {
  const b = snap.batches[TARGET_BATCH];
  const r = b?.results[TARGET_BAG];
  return {
    client,
    charredG: r ? String(r.charredG) : "0",
    seeds: r ? String(r.seeds) : "0",
    status: "idle",
    logs: [`载入 ${TARGET_BATCH} 基底版本 v${b?.version ?? 0}`],
    progress: 0,
  };
}

export function DrillPanel() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [a, setA] = useState<Side | null>(null);
  const [b, setB] = useState<Side | null>(null);
  const [injectFault, setInjectFault] = useState(false);
  const opIds = useRef<{ a: string; b: string }>({ a: "", b: "" });

  const reset = async () => {
    const s = await loadSnapshot();
    setSnap(s);
    setA(freshSide("窗口甲", s));
    setB(freshSide("窗口乙", s));
  };

  useEffect(() => {
    void reset();
  }, []);

  if (!snap || !a || !b) return null;

  const baseVersion = snap.batches[TARGET_BATCH]?.version ?? 0;

  const buildPayloadFrom = (side: Side, source: Snapshot, opId: string): BatchPayload => {
    const batch = source.batches[TARGET_BATCH];
    const rows: BatchRowDraft[] = (batch?.bagNos ?? [TARGET_BAG]).map((bag) => {
      const orig = batch?.results[bag];
      const isTarget = bag === TARGET_BAG;
      return {
        bagNo: bag,
        lab: { from: 3, to: 4 },
        charredG: isTarget ? Number(side.charredG) || 0 : orig?.charredG ?? 0,
        seeds: isTarget ? Number(side.seeds) || 0 : orig?.seeds ?? 0,
        status: orig?.status ?? "done",
        ...(orig?.note ? { note: orig.note } : {}),
      };
    });
    void opId;
    return { batchNo: TARGET_BATCH, labCode: batch?.labCode ?? "浮选室甲", baseVersion: batch?.version ?? 0, rows };
  };

  const runSide = async (which: "a" | "b") => {
    const side = which === "a" ? a : b;
    const setSide = which === "a" ? setA : setB;
    const opId = `DRILL-${which}-${Date.now()}`;
    opIds.current[which] = opId;
    if (injectFault) injectFailures(opId, 1); // 给每个窗口各注入 1 次故障，顺带演示断点重放
    const payload = buildPayloadFrom(side, snap, opId);
    const log = (text: string) => setSide((s) => (s ? { ...s, logs: [...s.logs, text] } : s));

    // 逐袋写入
    for (const row of payload.rows) {
      setSide((s) => (s ? { ...s, status: "writing" } : s));
      try {
        await writeBatchRow(opId, payload, row.bagNo);
        log(`袋 ${row.bagNo} 写入暂存区`);
        setSide((s) => (s ? { ...s, progress: s.progress + 1 } : s));
      } catch {
        log(`⚠ ${row.bagNo} 网络故障（已写袋不回滚）`);
        setSide((s) => (s ? { ...s, status: "error" } : s));
        return;
      }
    }

    // 最后一步 CAS：两个窗口只有一个能过
    setSide((s) => (s ? { ...s, status: "submitting" } : s));
    log("逐袋完成，提交批次做版本校验…");
    try {
      const res = await finalizeBatch(opId, payload);
      log(`✅ 放行：提交成功，${TARGET_BATCH} 升至 v${res.version}`);
      setSide((s) => (s ? { ...s, status: "won" } : s));
    } catch (e) {
      if (e instanceof ConflictError) {
        log(`⛔ 拒绝：另一窗口已抢先提交，服务器当前 v${e.serverVersion}`);
        log("草稿保留并显示冲突提示（可在'浮选批次'面板以新版本续传）");
        setSide((s) => (s ? { ...s, status: "lost" } : s));
      } else {
        log(`错误：${String(e)}`);
        setSide((s) => (s ? { ...s, status: "error" } : s));
      }
    }
    const s2 = await loadSnapshot();
    setSnap(s2);
  };

  const retrySide = async (which: "a" | "b") => {
    const setSide = which === "a" ? setA : setB;
    const opId = opIds.current[which];
    // 用服务器最新版本做基底（冲突重放必须带新版本），不用旧闭包里的快照
    const latest = await loadSnapshot();
    setSnap(latest);
    const seeded = freshSide(which === "a" ? "窗口甲" : "窗口乙", latest);
    const curSide = (which === "a" ? a : b)!;
    const side: Side = {
      ...seeded,
      charredG: curSide.charredG,
      seeds: curSide.seeds,
      status: "writing",
      progress: 0,
      logs: [...curSide.logs, "只重放未完成袋（批次号/已写袋复用，基底改为服务器最新版本）…"],
    };
    setSide(side);
    const payload = buildPayloadFrom(side, latest, opId);
    const log = (text: string) => setSide((s) => (s ? { ...s, logs: [...s.logs, text] } : s));
    for (const row of payload.rows) {
      await writeBatchRow(opId, payload, row.bagNo); // 服务端幂等：已写袋直接跳过
      log(`袋 ${row.bagNo} 已确认（已写则幂等跳过）`);
    }
    try {
      const res = await finalizeBatch(opId, payload);
      log(`✅ 放行：v${res.version}`);
      setSide((s) => (s ? { ...s, status: "won" } : s));
    } catch (e) {
      if (e instanceof ConflictError) {
        log(`⛔ 仍冲突：服务器 v${e.serverVersion}，草稿继续保留`);
        setSide((s) => (s ? { ...s, status: "lost" } : s));
      }
    }
    setSnap(await loadSnapshot());
  };

  const SideCard = ({ side, which }: { side: Side; which: "a" | "b" }) => (
    <article className={`drill-side drill-${side.status}`}>
      <header>
        <strong>{side.client}</strong>
        <span className="op-status op-status-running">基于 v{baseVersion} 的草稿</span>
      </header>
      <div className="field-grid">
        <label>
          <span>{TARGET_BAG} 炭化物 g</span>
          <input value={side.charredG} onChange={(e) => {
            const set = which === "a" ? setA : setB;
            set((s) => (s ? { ...s, charredG: e.target.value } : s));
          }} />
        </label>
        <label>
          <span>种子 粒</span>
          <input value={side.seeds} onChange={(e) => {
            const set = which === "a" ? setA : setB;
            set((s) => (s ? { ...s, seeds: e.target.value } : s));
          }} />
        </label>
      </div>
      <div className="op-progress">
        <div className="progress-track">
          <div className="progress-bar" style={{ width: `${(side.progress / (snap.batches[TARGET_BATCH]?.bagNos.length || 1)) * 100}%` }} />
        </div>
      </div>
      <div className="drill-logs">
        {side.logs.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
      <div className="card-actions">
        {side.status === "idle" || side.status === "writing" || side.status === "submitting" ? (
          <button className="primary-action" disabled={side.status !== "idle"} onClick={() => runSide(which)}>
            {side.status === "idle" ? "提交此窗口" : "处理中…"}
          </button>
        ) : side.status === "error" ? (
          <button className="primary-action" onClick={() => retrySide(which)}>只重放未完成袋</button>
        ) : side.status === "won" ? (
          <span className="hint ok">✅ 唯一放行的一份</span>
        ) : (
          <span className="hint warn">⛔ 草稿已保留 · 冲突提示</span>
        )}
      </div>
    </article>
  );

  const serverNow = snap.batches[TARGET_BATCH];

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>并发演练场</p>
          <h2>两个窗口同时提交 {TARGET_BATCH}</h2>
        </div>
        <button onClick={reset}>重置演练</button>
      </div>
      <p className="hint">
        两侧各自持同一份草稿（基底 v{baseVersion}），改成不同数值后分别点提交，或在真实浏览器里开两个标签页同时操作同一条批次。
      </p>
      <label className="checkline">
        <input type="checkbox" checked={injectFault} onChange={(e) => setInjectFault(e.target.checked)} />
        同时给每个窗口注入 1 次网络故障（观察：逐袋 checkpoint → 只补未完成袋 → 批次号/暂存不重复占用）
      </label>

      <div className="drill-grid">
        <SideCard side={a} which="a" />
        <div className="drill-vs">同时提交 → CAS</div>
        <SideCard side={b} which="b" />
      </div>

      <div className="server-now">
        服务器当前：{TARGET_BATCH} <strong>v{serverNow.version}</strong>
        {serverNow.submittedAt ? ` · ${new Date(serverNow.submittedAt).toLocaleTimeString()} 提交` : ""} ·{" "}
        {TARGET_BAG} = {serverNow.results[TARGET_BAG].charredG}g / {serverNow.results[TARGET_BAG].seeds}粒
      </div>
    </section>
  );
}
