import { useState } from "react";
import { useStore } from "../store";
import { formatTime } from "../sync";
import { injectFailures } from "../server";
import type { FieldReg, OutboxOp } from "../types";

const statusText: Record<OutboxOp["status"], string> = {
  waiting: "待发送",
  running: "发送中",
  done: "完成",
  error: "失败待重放",
  conflict: "版本冲突",
};

export function FieldPanel() {
  const store = useStore();
  const [bagNo, setBagNo] = useState("");
  const [unitCode, setUnitCode] = useState(store.snap.units[0]?.code ?? "T0203");
  const [from, setFrom] = useState(3);
  const [to, setTo] = useState(3);
  const [soilColor, setSoilColor] = useState("");

  const submit = async () => {
    if (!bagNo.trim()) return;
    const reg: FieldReg = {
      bagNo: bagNo.trim().toUpperCase(),
      unitCode,
      stratum: { from: Math.min(from, to), to: Math.max(from, to) },
      ...(soilColor.trim() ? { soilColor: soilColor.trim() } : {}),
    };
    await store.registerField(reg);
    setBagNo("");
    setSoilColor("");
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>现场离线登记 · outbox</p>
          <h2>现场登记与续传队列</h2>
        </div>
        <div className={`conn-dot ${store.online ? "online" : "offline"}`}>
          {store.online ? "在线" : "离线"}
        </div>
      </div>

      <div className="field-grid">
        <label>
          <span>袋号（合并主键）</span>
          <input placeholder="如 S-1004" value={bagNo} onChange={(e) => setBagNo(e.target.value)} />
        </label>
        <label>
          <span>所属探方</span>
          <select value={unitCode} onChange={(e) => setUnitCode(e.target.value)}>
            {store.snap.units.map((u) => (
              <option key={u.code} value={u.code}>
                {u.code} {u.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>现场地层：第</span>
          <div className="range-inputs">
            <input type="number" min={1} value={from} onChange={(e) => setFrom(Number(e.target.value))} />
            <em>至第</em>
            <input type="number" min={1} value={to} onChange={(e) => setTo(Number(e.target.value))} />
            <em>层</em>
          </div>
        </label>
        <label>
          <span>土色（可选）</span>
          <input placeholder="如 灰褐土" value={soilColor} onChange={(e) => setSoilColor(e.target.value)} />
        </label>
      </div>
      <div className="card-actions" style={{ marginTop: 14 }}>
        <button className="primary-action" onClick={submit} disabled={!bagNo.trim()}>
          {store.online ? "登记并入队" : "离线登记（本地暂存）"}
        </button>
        {!store.online && <span className="hint">回连后自动按袋号逐件合并，不会覆盖双方原值</span>}
      </div>

      <h3 className="subhead">续传队列（{store.outbox.length}）</h3>
      <div className="op-list">
        {store.outbox.length === 0 && <p className="hint">队列是空的。离线登记几袋，或提交浮选批次试试。</p>}
        {store.outbox.map((op) => (
          <article key={op.id} className={`op-card op-${op.status}`}>
            <header>
              <strong>
                {op.kind === "field-register"
                  ? `现场登记 ${op.field!.bagNo}（${op.field!.unitCode}）`
                  : `浮选批次 ${op.batch!.batchNo} · ${op.batch!.labCode}`}
              </strong>
              <span className={`op-status op-status-${op.status}`}>{statusText[op.status]}</span>
            </header>

            {op.kind === "batch-submit" && (
              <div className="op-progress">
                <div className="progress-track">
                  <div
                    className="progress-bar"
                    style={{ width: `${(op.completedBags.length / op.batch!.rows.length) * 100}%` }}
                  />
                </div>
                <span>
                  已写入 {op.completedBags.length}/{op.batch!.rows.length} 袋
                </span>
              </div>
            )}

            {op.message && <p className="op-msg">{op.message}</p>}

            <details className="op-logs">
              <summary>处理日志（{op.logs.length}）</summary>
              {op.logs.map((l, i) => (
                <div key={i} className="op-log-line">
                  <code>{formatTime(l.at)}</code> {l.text}
                </div>
              ))}
            </details>

            <div className="card-actions">
              {op.status === "error" && (
                <>
                  <button className="primary-action" onClick={() => store.retryOp(op.id)}>
                    只重放未完成袋
                  </button>
                  <button
                    onClick={() => {
                      injectFailures(op.id, 2);
                      store.appendLog("fault", `已对该操作注入 2 次网络故障：观察逐袋断点与批次号复用`);
                    }}
                  >
                    再注入2次故障
                  </button>
                </>
              )}
              {op.status === "conflict" && (
                <button className="primary-action" onClick={() => store.retryOp(op.id)}>
                  按服务器 v{store.snap.batches[op.batch!.batchNo]?.version ?? 0} 续传草稿
                </button>
              )}
              {op.status === "waiting" && <span className="hint">{store.online ? "排队中…" : "等待回连…"}</span>}
              {op.status === "running" && <span className="hint">逐袋写入中…</span>}
              {op.status === "done" && <span className="hint ok">幂等完成，重放也不会重复占用批次号</span>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
