import { useState } from "react";
import { useStore } from "../store";
import { formatTime } from "../sync";
import type { BatchPayload, BatchRowDraft, ResultStatus, ServerBatch } from "../types";

function blankRow(bagNo: string, unitBags: string[]): BatchRowDraft {
  return { bagNo: bagNo || unitBags[0] || "", lab: { from: 3, to: 3 }, charredG: 0, seeds: 0, status: "pending" };
}

function DraftEditor({ batchNo, onClose }: { batchNo: string; onClose: () => void }) {
  const store = useStore();
  const draft = store.drafts.find((d) => d.payload.batchNo === batchNo);
  if (!draft) return null;
  const p = draft.payload;
  const conflict = draft.conflict;
  const serverBatch = store.snap.batches[p.batchNo];
  const allBags = Object.values(store.snap.samples);

  const update = (updater: (x: BatchPayload) => BatchPayload) => store.saveDraft(batchNo, updater);
  const setRow = (idx: number, patch: Partial<BatchRowDraft>) =>
    update((x) => ({ ...x, rows: x.rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)) }));

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3>浮选批次草稿 {p.batchNo.startsWith("本地-") ? "（提交时占用正式批次号）" : ""}</h3>
        {conflict && (
          <div className="conflict-banner">
            ⚠ 提交冲突：另一窗口已把该批次提交到 v{conflict.serverVersion}，本份只保留为草稿。
            下方可见服务器现值，核对差异后"以服务器版本续传"会逐袋幂等重放。
          </div>
        )}
        <div className="field-grid">
          <label>
            <span>批次号 / 实验室</span>
            <input value={p.labCode} onChange={(e) => update((x) => ({ ...x, labCode: e.target.value }))} />
          </label>
          <label>
            <span>基底版本（CAS）</span>
            <input value={`草稿基于 v${p.baseVersion}${serverBatch ? `，服务器当前 v${serverBatch.version}` : "，服务器尚无此批次"}`} readOnly />
          </label>
        </div>

        <table className="draft-table">
          <thead>
            <tr>
              <th>袋号</th>
              <th>实验室地层</th>
              <th>炭化物 g</th>
              <th>种子 粒</th>
              <th>检测状态</th>
              <th>备注</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {p.rows.map((row, idx) => (
              <tr key={idx}>
                <td>
                  <select value={row.bagNo} onChange={(e) => setRow(idx, { bagNo: e.target.value })}>
                    {allBags.map((b) => (
                      <option key={b.bagNo} value={b.bagNo}>
                        {b.bagNo}（{b.unitCode}）
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <div className="range-inputs compact">
                    第
                    <input
                      type="number"
                      value={row.lab.from}
                      onChange={(e) => setRow(idx, { lab: { ...row.lab, from: Number(e.target.value) } })}
                    />
                    –
                    <input
                      type="number"
                      value={row.lab.to}
                      onChange={(e) => setRow(idx, { lab: { ...row.lab, to: Number(e.target.value) } })}
                    />
                    层
                  </div>
                </td>
                <td>
                  <input type="number" step="0.1" value={row.charredG} disabled={row.status === "pending"}
                    onChange={(e) => setRow(idx, { charredG: Number(e.target.value) })} />
                </td>
                <td>
                  <input type="number" value={row.seeds} disabled={row.status === "pending"}
                    onChange={(e) => setRow(idx, { seeds: Number(e.target.value) })} />
                </td>
                <td>
                  <select
                    value={row.status}
                    onChange={(e) => setRow(idx, { status: e.target.value as ResultStatus, ...(e.target.value === "pending" ? { charredG: 0, seeds: 0 } : {}) })}
                  >
                    <option value="done">已回填</option>
                    <option value="pending">检测中（挡封存）</option>
                  </select>
                </td>
                <td>
                  <input value={row.note ?? ""} onChange={(e) => setRow(idx, { note: e.target.value })} />
                </td>
                <td>
                  <button onClick={() => update((x) => ({ ...x, rows: x.rows.filter((_, i) => i !== idx) }))}>删</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {conflict && serverBatch && (
          <div className="server-side">
            <h4>服务器现值（v{serverBatch.version}，{serverBatch.submittedAt ? formatTime(serverBatch.submittedAt) : ""}）</h4>
            <table className="draft-table">
              <tbody>
                {Object.values(serverBatch.results).map((r) => (
                  <tr key={r.bagNo}>
                    <td>{r.bagNo}</td>
                    <td>{r.status === "done" ? `${r.charredG}g / ${r.seeds}粒` : "检测中"}</td>
                    <td>{r.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="card-actions">
          <button onClick={() => update((x) => ({ ...x, rows: [...x.rows, blankRow("", allBags.map((b) => b.bagNo))] }))}>
            + 认领一袋
          </button>
          <button
            className="primary-action"
            onClick={async () => {
              await store.submitDraft(batchNo);
              onClose();
            }}
          >
            {store.online ? "提交（逐袋写入+版本校验）" : "暂存，回连后提交"}
          </button>
          <button onClick={onClose}>关闭（草稿保留）</button>
        </div>
      </div>
    </div>
  );
}

function BatchCard({ batch }: { batch: ServerBatch }) {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const rows = Object.values(batch.results);
  const pending = rows.filter((r) => r.status === "pending").length;

  const editAsDraft = () => {
    const existing = store.drafts.find((d) => d.payload.batchNo === batch.batchNo);
    if (existing) {
      setOpen(true);
      return;
    }
    const draftRows: BatchRowDraft[] = rows.map((r) => {
      const sample = Object.values(store.snap.samples).find((s) => s.bagNo === r.bagNo);
      return {
        bagNo: r.bagNo,
        lab: sample?.labStratum ? { ...sample.labStratum } : { from: 1, to: 1 },
        charredG: r.charredG,
        seeds: r.seeds,
        status: r.status,
        ...(r.note ? { note: r.note } : {}),
      };
    });
    const no = store.createDraft({
      batchNo: batch.batchNo,
      labCode: batch.labCode,
      baseVersion: batch.version,
      rows: draftRows,
    });
    void no;
    setOpen(true);
  };

  return (
    <article className="batch-card">
      <header>
        <strong>{batch.batchNo}</strong>
        <span className="badge">v{batch.version}</span>
        {pending > 0 && <span className="badge badge-pending">{pending} 袋检测中</span>}
        <span className="hint">{batch.labCode}</span>
      </header>
      <div className="batch-bags">
        {rows.map((r) => (
          <span key={r.bagNo} className={`claim-chip ${r.status === "pending" ? "claim-pending" : ""}`}>
            {r.bagNo}：{r.status === "pending" ? "未回填" : `${r.charredG}g · ${r.seeds}粒`}
          </span>
        ))}
      </div>
      <div className="card-actions">
        <button onClick={editAsDraft}>结果变化，改后提交</button>
      </div>
      {open && (
        <DraftEditor
          batchNo={store.drafts.find((d) => d.payload.batchNo === batch.batchNo)?.payload.batchNo ?? ""}
          onClose={() => setOpen(false)}
        />
      )}
    </article>
  );
}

export function BatchPanel() {
  const store = useStore();
  const [editing, setEditing] = useState<string | null>(null);

  const newDraft = () => {
    const allBags = Object.values(store.snap.samples).map((b) => b.bagNo);
    const no = store.createDraft({
      labCode: `浮选室 · ${new Date().toISOString().slice(0, 10)}`,
      rows: allBags.length ? [blankRow(allBags[0], allBags)] : [],
    });
    setEditing(no);
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>实验室浮选</p>
          <h2>浮选批次（乐观并发）</h2>
        </div>
        <button className="primary-action" onClick={newDraft}>
          登记新批次
        </button>
      </div>
      <p className="hint">
        两个窗口同时提交同一批次时只放行一份（版本号 CAS）；败者保留草稿并显示冲突，可与服务器现值比对后续传。
      </p>

      {store.drafts.length > 0 && (
        <>
          <h3 className="subhead">本窗口草稿（{store.drafts.length}）</h3>
          <div className="draft-strip">
            {store.drafts.map((d) => (
              <button
                key={d.payload.batchNo}
                className={`draft-pill ${d.conflict ? "draft-conflict" : ""}`}
                onClick={() => setEditing(d.payload.batchNo)}
              >
                {d.payload.batchNo}
                <small>{d.conflict ? `⚠ 冲突：服务器 v${d.conflict.serverVersion}` : `${d.payload.rows.length} 袋`}</small>
              </button>
            ))}
          </div>
        </>
      )}

      <h3 className="subhead">服务器批次（{Object.values(store.snap.batches).length}）</h3>
      <div className="batch-grid">
        {Object.values(store.snap.batches)
          .sort((a, b) => a.batchNo.localeCompare(b.batchNo))
          .map((b) => (
            <BatchCard key={b.batchNo} batch={b} />
          ))}
      </div>

      {editing && <DraftEditor batchNo={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}
