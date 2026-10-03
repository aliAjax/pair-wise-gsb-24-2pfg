import { useState } from "react";
import { useStore } from "../store";
import { rangeText, stratumStatusText, unitBags } from "../sync";
import type { StratumRange } from "../types";

function ResolveDialog({ bagNo, onClose }: { bagNo: string; onClose: () => void }) {
  const store = useStore();
  const sample = store.snap.samples[bagNo];
  const [from, setFrom] = useState(sample?.fieldStratum?.from ?? 1);
  const [to, setTo] = useState(sample?.fieldStratum?.to ?? 1);
  if (!sample) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>领队核对地层 · {bagNo}</h3>
        <div className="compare-box">
          <div>
            <span>现场登记原值</span>
            <strong>{rangeText(sample.fieldStratum)}</strong>
          </div>
          <div>
            <span>实验室浮选原值{sample.labStratumBatchNo ? `（${sample.labStratumBatchNo}）` : ""}</span>
            <strong>{rangeText(sample.labStratum)}</strong>
          </div>
        </div>
        <p className="hint">双方原值不会被覆盖；核对后仅记录"采用范围"。新实验室值到达时核对结果自动失效，需重新核对。</p>
        <div className="range-inputs">
          <label>
            <span>采用 第</span>
            <input type="number" min={1} max={20} value={from} onChange={(e) => setFrom(Number(e.target.value))} />
          </label>
          <em>至</em>
          <label>
            <span>第</span>
            <input type="number" min={1} max={20} value={to} onChange={(e) => setTo(Number(e.target.value))} />
          </label>
          <em>层</em>
        </div>
        <div className="card-actions">
          <button className="primary-action" onClick={async () => {
            const range: StratumRange = { from: Math.min(from, to), to: Math.max(from, to) };
            await store.resolveStratum(bagNo, range);
            onClose();
          }}>
            确认核对
          </button>
          <button onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

export function RecordsPanel() {
  const store = useStore();
  const [resolveBag, setResolveBag] = useState<string | null>(null);

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>一条可续作的记录</p>
          <h2>探方 → 土样（袋号） → 浮选批次</h2>
        </div>
      </div>
      <p className="hint">
        按袋号逐件合并：同一袋可被多条批次认领（认领取并集）；现场与实验室地层范围不一致时，双方原值都保留。
      </p>

      <div className="linked-list">
        {store.snap.units.map((unit) => {
          const bags = unitBags(store.snap, unit.code);
          return (
            <div key={unit.code} className="linked-unit">
              <h3>
                {unit.code} <small>{unit.name}</small>
                {unit.sealed && <span className="badge badge-sealed">已封存</span>}
              </h3>
              <div className="bag-list">
                {bags.map((bag) => (
                  <article key={bag.bagNo} className={`bag-card strata-${bag.stratumStatus}`}>
                    <div className="bag-head">
                      <strong>{bag.bagNo}</strong>
                      {bag.soilColor && <span>{bag.soilColor}</span>}
                      {bag.weightKg != null && <span>{bag.weightKg}kg</span>}
                      <span className={`strata-tag strata-tag-${bag.stratumStatus}`}>
                        {stratumStatusText[bag.stratumStatus]}
                      </span>
                    </div>
                    <div className="strata-compare">
                      <div>
                        <span>现场</span>
                        <code>{rangeText(bag.fieldStratum)}</code>
                      </div>
                      <div>
                        <span>实验室</span>
                        <code>{rangeText(bag.labStratum)}</code>
                      </div>
                      {bag.resolvedRange && (
                        <div className="resolved-range">
                          <span>领队采用</span>
                          <code>{rangeText(bag.resolvedRange)}</code>
                        </div>
                      )}
                    </div>
                    <div className="claim-line">
                      <span>认领批次：</span>
                      {bag.batchNos.length === 0 && <em>尚未认领</em>}
                      {bag.batchNos.map((bn) => {
                        const batch = store.snap.batches[bn];
                        const res = batch?.results[bag.bagNo];
                        return (
                          <span key={bn} className={`claim-chip ${res?.status === "pending" ? "claim-pending" : ""}`}>
                            {bn}
                            {res ? (res.status === "pending" ? " · 检测中" : ` · ${res.charredG}g/${res.seeds}粒`) : " · 暂存"}
                          </span>
                        );
                      })}
                    </div>
                    {bag.stratumStatus === "conflict" && (
                      <button className="link-btn" onClick={() => setResolveBag(bag.bagNo)}>
                        请领队核对双方原值 →
                      </button>
                    )}
                  </article>
                ))}
                {bags.length === 0 && <p className="hint">暂无土样，可在下方现场登记。</p>}
              </div>
            </div>
          );
        })}
      </div>

      {resolveBag && <ResolveDialog bagNo={resolveBag} onClose={() => setResolveBag(null)} />}
    </section>
  );
}
