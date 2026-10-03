import { useStore } from "../store";
import { computeStat, sealBlockers, statHash } from "../sync";

export function UnitsPanel() {
  const store = useStore();
  const { snap, marks } = store;

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>探方封存闸门</p>
          <h2>探方 · 统计与封存</h2>
        </div>
      </div>
      <p className="hint">
        浮选结果变化 → 引用该批次的探方统计哈希失效，必须重算；有未回填检测、地层冲突未核对或统计失效时，封存按钮被挡住。
      </p>
      <div className="units-grid">
        {snap.units.map((u) => {
          const stat = computeStat(snap, u.code);
          const hash = statHash(snap, u.code);
          const mark = marks[u.code];
          const stale = !mark || mark.hash !== hash;
          const blockers = sealBlockers(snap, u.code, marks);
          return (
            <article key={u.code} className={`unit-card ${u.sealed ? "sealed" : ""}`}>
              <header>
                <div>
                  <h3>{u.code}</h3>
                  <p>{u.name}</p>
                </div>
                {u.sealed ? (
                  <span className="badge badge-sealed">已封存</span>
                ) : blockers.length ? (
                  <span className="badge badge-blocked">封存被挡</span>
                ) : (
                  <span className="badge badge-ready">可封存</span>
                )}
              </header>

              <div className="stat-row">
                <span>土样袋数</span>
                <strong>{stat.bagCount}</strong>
              </div>
              <div className="stat-row">
                <span>已被浮选认领</span>
                <strong>{stat.claimedBags}</strong>
              </div>
              <div className="stat-row">
                <span>已回填结果（条）</span>
                <strong>{stat.doneResults}</strong>
              </div>
              <div className="stat-row">
                <span>炭化遗物合计</span>
                <strong>{stat.charredG.toFixed(1)} g</strong>
              </div>
              <div className="stat-row">
                <span>炭化种子合计</span>
                <strong>{stat.seeds} 粒</strong>
              </div>

              <div className={`hash-line ${stale ? "hash-stale" : "hash-fresh"}`}>
                统计指纹 <code>{hash.slice(0, 8)}</code>
                {stale ? " · 已失效" : mark ? ` · 已于 ${new Date(mark.at).toLocaleTimeString()} 重算` : ""}
              </div>

              {blockers.length > 0 && (
                <ul className="blockers">
                  {blockers.map((b) => (
                    <li key={b}>⛔ {b}</li>
                  ))}
                </ul>
              )}

              <div className="card-actions">
                <button onClick={() => store.recalc(u.code)} disabled={!stale} className={stale ? "primary-action" : ""}>
                  {stale ? "重算统计" : "统计为最新"}
                </button>
                <button
                  onClick={async () => {
                    const err = await store.sealUnit(u.code);
                    if (err) store.appendLog("seal", `${u.code} 封存被挡：${err}`);
                  }}
                  disabled={u.sealed || blockers.length > 0}
                >
                  封存探方
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
