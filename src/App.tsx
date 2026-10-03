import { useEffect, useReducer, useState } from "react";
import "./styles.css";
import { ServerApi } from "./domain/api";
import { ClientEngine } from "./domain/engine";
import { isStatsStale } from "./domain/store";
import type { ClientEngine as Engine } from "./domain/engine";
import type { OutboxOp, SquareStats, Toast } from "./domain/types";

const RULES = [
  "现场离线登记，回连按袋号逐件合并",
  "地层范围不一致，保留双方原值待领队核对",
  "浮选结果变化 → 探方统计失效重算，并挡住封存",
  "两窗口并发同批次只放行一份，另一份留草稿+冲突提示",
  "写入失败只重做未完成样本，重放不重复占用批次号",
];

function useEngine(winA: Engine, winB: Engine, lab: Engine) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const unsubs = [winA, winB, lab].map((e) => e.subscribe(force));
    return () => unsubs.forEach((u) => u());
  }, [winA, winB, lab]);
}

function opLabel(op: OutboxOp): string {
  if (op.kind === "register-bag") {
    const p = op.payload as { bagNo: string };
    return `登记土样 ${p.bagNo}`;
  }
  if (op.kind === "submit-batch") {
    const p = op.payload as { draftId: string };
    return `提交浮选批次 ${p.draftId}`;
  }
  const p = op.payload as { batchId: string };
  return `修订浮选结果 ${p.batchId}`;
}

const stateLabel: Record<OutboxOp["state"], string> = {
  queued: "排队",
  inflight: "发送中",
  done: "已完成",
  error: "失败可续作",
  conflict: "并发冲突",
};

function ToastStack({ engine }: { engine: Engine }) {
  return (
    <div className="toast-stack">
      {engine.data.toasts.map((t: Toast) => (
        <div key={t.id} className={`toast toast-${t.level}`} onClick={() => engine.dismissToast(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function QueueCard({ engine }: { engine: Engine }) {
  const queue = [...engine.data.queue].reverse().slice(0, 6);
  return (
    <div className="subpanel">
      <div className="subpanel-head">
        <h3>离线续作队列</h3>
        <button onClick={() => engine.syncQueue("手动")} disabled={!engine.online}>
          回连同步/重放
        </button>
      </div>
      {queue.length === 0 && <p className="muted-text">暂无操作</p>}
      {queue.map((op) => (
        <div key={op.id} className={`queue-row state-${op.state}`}>
          <div className="queue-main">
            <span className="queue-label">{opLabel(op)}</span>
            <i className={`pill pill-${op.state}`}>{stateLabel[op.state]}</i>
          </div>
          {op.finishedBagNos && op.finishedBagNos.length > 0 && (
            <small>已完成件：{op.finishedBagNos.join("、")}（重放只补剩余，不重新发号）</small>
          )}
          {op.lastError && <small className="err-text">{op.lastError}</small>}
          {(op.state === "error" || op.state === "queued") && engine.online && (
            <button className="mini" onClick={() => engine.retryOp(op.id)}>
              立即续作
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function RegisterForm({ engine }: { engine: Engine }) {
  const [bagNo, setBagNo] = useState("");
  const [squareId, setSquareId] = useState("T0203");
  const [stratum, setStratum] = useState("");
  return (
    <div className="subpanel">
      <h3>现场土样登记</h3>
      <div className="form-row">
        <label>
          <span>袋号</span>
          <input value={bagNo} onChange={(e) => setBagNo(e.target.value)} placeholder="如 B-1003" />
        </label>
        <label>
          <span>探方</span>
          <select value={squareId} onChange={(e) => setSquareId(e.target.value)}>
            <option>T0203</option>
            <option>T0204</option>
          </select>
        </label>
      </div>
      <label className="full-label">
        <span>现场地层（原值照录，不与实验室口径互改）</span>
        <input value={stratum} onChange={(e) => setStratum(e.target.value)} placeholder="如 第三层（下文化层）" />
      </label>
      <button
        className="primary-action"
        onClick={() => {
          if (!bagNo.trim() || !stratum.trim()) {
            engine.toast("warn", "袋号与地层都要填");
            return;
          }
          engine.registerFieldBag(bagNo.trim(), squareId, stratum.trim());
          setBagNo("");
          setStratum("");
        }}
      >
        {engine.online ? "登记并按袋号合并" : "离线暂存（回连后合并）"}
      </button>
    </div>
  );
}

function BatchComposer({
  engine,
  other,
  armFailure,
  setArmFailure,
}: {
  engine: Engine;
  other: Engine;
  armFailure: boolean;
  setArmFailure: (v: boolean) => void;
}) {
  const c = engine.data.batchComposer;
  const server = engine.data.server;
  const bags = server?.bags.filter((b) => b.squareId === c.squareId) ?? [];
  const [seeds, setSeeds] = useState("12");
  const [charcoal, setCharcoal] = useState("1.5");
  const [note, setNote] = useState("现场浮选");

  const raceSamples = [
    { bagNo: "B-1004", squareId: "T0204" },
    { bagNo: "B-1001", squareId: "T0203" },
  ];

  return (
    <div className="subpanel">
      <h3>浮选批次草稿</h3>
      <div className="form-row">
        <label>
          <span>归属探方</span>
          <select
            value={c.squareId}
            onChange={(e) =>
              engine.composerSetSquare(e.target.value)
            }
          >
            <option>T0203</option>
            <option>T0204</option>
          </select>
        </label>
      </div>
      <div className="bag-pick">
        {bags.map((b) => (
          <label key={b.bagNo} className="check-chip">
            <input
              type="checkbox"
              checked={c.bagNos.includes(b.bagNo)}
              onChange={() => engine.composerToggleBag(b.bagNo, c.squareId)}
            />
            <span>
              {b.bagNo} <em>{b.stratum.field?.raw ?? b.stratum.lab?.raw ?? "地层待补"}</em>
            </span>
          </label>
        ))}
        {bags.length === 0 && <small className="muted-text">本地快照暂无该探方袋，点“拉取最新”</small>}
      </div>
      <div className="form-row">
        <label>
          <span>炭化种子(粒)</span>
          <input value={seeds} onChange={(e) => setSeeds(e.target.value)} />
        </label>
        <label>
          <span>炭屑(g)</span>
          <input value={charcoal} onChange={(e) => setCharcoal(e.target.value)} />
        </label>
      </div>
      <label className="full-label">
        <span>备注</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <label className="check-line">
        <input type="checkbox" checked={armFailure} onChange={(e) => setArmFailure(e.target.checked)} />
        <span>模拟写入故障（写完前 2 件后断一次，用于验证续作不重发号）</span>
      </label>
      <div className="btn-row">
        <button
          className="primary-action"
          onClick={() => {
            engine.composerSetResult({
              charredSeeds: Number(seeds) || 0,
              charcoalG: Number(charcoal) || 0,
              note,
              version: 0,
              updatedAt: Date.now(),
            });
            engine.submitComposedBatch(armFailure ? 2 : undefined);
          }}
        >
          提交批次
        </button>
        <button onClick={() => engine.pull()}>拉取最新</button>
      </div>
      <button
        className="race-btn"
        onClick={() =>
          engine.submitConcurrentSameDraft(other, raceSamples, {
            charredSeeds: 7,
            charcoalG: 0.4,
            note: "两窗口同编",
            version: 0,
            updatedAt: Date.now(),
          })
        }
      >
            并发演练：与另一窗口同时提交同一批次（只放行一份）
      </button>
    </div>
  );
}

function DraftsCard({ engine }: { engine: Engine }) {
  const drafts = Object.values(engine.data.drafts);
  if (drafts.length === 0) return null;
  return (
    <div className="subpanel conflict-panel">
      <h3>被挡下的草稿（冲突提示）</h3>
      {drafts.map((d) => (
        <div key={d.id} className="draft-card">
          <strong>{d.id}</strong>
          <p className="err-text">{d.conflictNote}</p>
          <small>袋：{d.bagNos.join("、")}；本份未占用批次号，可核对后另编新批提交</small>
        </div>
      ))}
    </div>
  );
}

function FieldWindow({
  engine,
  other,
  armFailure,
  setArmFailure,
}: {
  engine: Engine;
  other: Engine;
  armFailure: boolean;
  setArmFailure: (v: boolean) => void;
}) {
  return (
    <section className="panel window-panel">
      <header className="window-head">
        <div>
          <p className="eyebrow">现场端</p>
          <h2>{engine.windowId}</h2>
        </div>
        <button
          className={engine.online ? "online on" : "online off"}
          onClick={() => engine.setOnline(!engine.online)}
        >
          {engine.online ? "● 在线" : "○ 离线"}
        </button>
      </header>
      <RegisterForm engine={engine} />
      <BatchComposer engine={engine} other={other} armFailure={armFailure} setArmFailure={setArmFailure} />
      <DraftsCard engine={engine} />
      <QueueCard engine={engine} />
      <ToastStack engine={engine} />
    </section>
  );
}

function SquaresPanel({ engine, api }: { engine: Engine; api: ServerApi }) {
  const state = api.state;
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">封存闸门</p>
          <h2>探方统计与封存</h2>
        </div>
      </div>
      <div className="square-grid">
        {state.squares.map((sq) => {
          const gate = api.sealGate(sq.id);
          const stale = isStatsStale(state, sq.id);
          const stats: SquareStats = state.stats[sq.id];
          return (
            <article key={sq.id} className={`square-card ${gate.blocked ? "blocked" : "clear"}`}>
              <header>
                <h3>{sq.name}</h3>
                {sq.sealed ? <i className="pill pill-sealed">已封存</i> : <i className="pill">未封存</i>}
              </header>
              {stats && (
                <ul className="stats-list">
                  <li>土样袋 <b>{stats.bagCount}</b>（已认领 {stats.claimedBagCount}）</li>
                  <li>浮选样本 <b>{stats.writtenCount}/{stats.sampleCount}</b> 已写回</li>
                  <li>炭化种子 <b className={stale ? "stale-num" : ""}>{stats.charredSeeds}</b> 粒 · 炭屑 <b className={stale ? "stale-num" : ""}>{stats.charcoalG}</b> g</li>
                  <li className={stale ? "stale-tag" : "fresh-tag"}>
                    {stale ? "统计签名失配：浮选结果有变，需重算" : `统计有效（重算于 ${new Date(stats.recomputedAt).toLocaleTimeString()}）`}
                  </li>
                </ul>
              )}
              <ul className="blocker-list">
                {gate.blockers.map((b) => (
                  <li key={b}>⛔ {b}</li>
                ))}
                {gate.warnings.map((w) => (
                  <li key={w} className="warn-text">⚠️ {w}</li>
                ))}
                {!gate.blocked && gate.warnings.length === 0 && <li className="ok-text">✅ 无未决项，可以封存</li>}
              </ul>
              <div className="btn-row">
                <button onClick={() => engine.recompute(sq.id)} disabled={!stale}>
                  重算统计
                </button>
                <button
                  className="primary-action"
                  onClick={() => engine.seal(sq.id)}
                  disabled={sq.sealed}
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

function BagLedger({ api }: { api: ServerApi }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">袋号合并视图</p>
          <h2>土样袋台账（现场 / 实验室原值并置）</h2>
        </div>
      </div>
      <div className="table-wrap">
        <table className="ledger">
          <thead>
            <tr>
              <th>袋号</th>
              <th>探方</th>
              <th>现场地层原值</th>
              <th>实验室地层原值</th>
              <th>状态</th>
              <th>认领批次（可多批）</th>
            </tr>
          </thead>
          <tbody>
            {api.state.bags.map((b) => {
              const conflict = api.state.conflicts.find((c) => c.bagNo === b.bagNo);
              return (
                <tr key={b.bagNo} className={conflict?.status === "pending" ? "row-conflict" : ""}>
                  <td><b>{b.bagNo}</b></td>
                  <td>{b.squareId}</td>
                  <td className="stratum-cell">{b.stratum.field?.raw ?? <em>未登记</em>}</td>
                  <td className="stratum-cell">{b.stratum.lab?.raw ?? <em>未登记</em>}</td>
                  <td>
                    {conflict?.status === "pending" && <span className="pill pill-conflict">待领队核对</span>}
                    {conflict?.status === "resolved" && (
                      <span className="pill pill-ok">已核对：{conflict.resolvedValue}</span>
                    )}
                    {!conflict && <span className="pill pill-ok">一致/单方</span>}
                  </td>
                  <td>{b.claimedBy.length ? b.claimedBy.join("、") : <em>未认领</em>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LabPanel({ engine, api }: { engine: Engine; api: ServerApi }) {
  const [resolveBag, setResolveBag] = useState("B-1002");
  const [resolveVal, setResolveVal] = useState("第3层（以现场剖面为准）");
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">实验室 / 领队</p>
          <h2>浮选批次与结果修订</h2>
        </div>
      </div>
      <div className="batch-list">
        {api.state.batches.map((b) => (
          <article key={b.id} className="batch-card">
            <header>
              <h3>{b.batchNo ?? "（待发号）"} <small>{b.id} · {b.origin === "lab" ? "实验室批次" : "现场批次"}</small></h3>
              <i className={`pill pill-${b.status}`}>{b.status}</i>
            </header>
            <div className="sample-strip">
              {b.samples.map((s) => (
                <span key={s.bagNo} className={`sample-dot ${s.status}`} title={`${s.bagNo}: ${s.status}`}>
                  {s.bagNo.replace("B-", "")}
                </span>
              ))}
            </div>
            {b.result && (
              <p className="muted-text">
                炭化种子 {b.result.charredSeeds} 粒 · 炭屑 {b.result.charcoalG} g · {b.result.note} ·{" "}
                <b>结果版本 v{b.result.version}</b>
              </p>
            )}
            <ResultRevise engine={engine} batchId={b.id} current={b.result?.charredSeeds ?? 0} />
          </article>
        ))}
      </div>
      <div className="subpanel">
        <h3>领队核对地层冲突</h3>
        <p className="muted-text">
          待核对：{api.state.conflicts.filter((c) => c.status === "pending").map((c) => c.bagNo).join("、") || "无"}
        </p>
        <div className="form-row">
          <label>
            <span>袋号</span>
            <input value={resolveBag} onChange={(e) => setResolveBag(e.target.value)} />
          </label>
          <label className="grow">
            <span>核对结论（双方原值仍保留在台账）</span>
            <input value={resolveVal} onChange={(e) => setResolveVal(e.target.value)} />
          </label>
        </div>
        <button
          className="primary-action"
          onClick={() => {
            try {
              engine.resolveConflict(resolveBag.trim(), resolveVal.trim());
            } catch (e) {
              engine.toast("danger", (e as Error).message);
            }
          }}
        >
          确认核对结论
        </button>
      </div>
      <ToastStack engine={engine} />
    </section>
  );
}

function ResultRevise({
  engine,
  batchId,
  current,
}: {
  engine: Engine;
  batchId: string;
  current: number;
}) {
  const [v, setV] = useState(String(current + 15));
  return (
    <div className="revise-row">
      <span>修订炭化种子为</span>
      <input value={v} onChange={(e) => setV(e.target.value)} />
      <span>粒</span>
      <button
        onClick={() => {
          engine.requestResultUpdate(batchId, { charredSeeds: Number(v) || 0, note: "实验室复核更正" });
        }}
      >
        修订并使引用统计失效
      </button>
    </div>
  );
}

export default function App() {
  const [api, setApi] = useState(() => new ServerApi());
  const [winA, setWinA] = useState(() => new ClientEngine("窗口A", api, true));
  const [winB, setWinB] = useState(() => new ClientEngine("窗口B", api, true));
  const [lab, setLab] = useState(() => new ClientEngine("实验室/领队", api, true));
  const [armA, setArmA] = useState(false);
  const [armB, setArmB] = useState(false);
  const [session, setSession] = useState(0);

  useEngine(winA, winB, lab);

  const reset = () => {
    localStorage.removeItem("arch-sync-client:窗口A");
    localStorage.removeItem("arch-sync-client:窗口B");
    localStorage.removeItem("arch-sync-client:实验室/领队");
    const nextApi = new ServerApi();
    setApi(nextApi);
    setWinA(new ClientEngine("窗口A", nextApi, true));
    setWinB(new ClientEngine("窗口B", nextApi, true));
    setLab(new ClientEngine("实验室/领队", nextApi, true));
    setSession((s) => s + 1);
  };

  return (
    <main className="app-shell demo" key={session}>
      <section className="hero demo-hero">
        <div>
          <p className="eyebrow">hxwl-10 · 离线优先 · 可续作</p>
          <h1>探方—土样—浮选批次 接续记录</h1>
          <p className="subtitle">
            现场离线登记、回连按袋号合并；同一袋允许多批认领；结果变化驱动统计失效与封存闸门。
          </p>
          <ul className="rule-list">
            {RULES.map((r, i) => (
              <li key={r}><b>{i + 1}</b>{r}</li>
            ))}
          </ul>
        </div>
        <div className="stack-card">
          <span>演练引导</span>
          <ol className="guide">
            <li>窗口A 切到“离线”，登记 B-1003（第4层）和 B-1002（第三层），再勾袋提交批次</li>
            <li>勾选“模拟写入故障”后提交，观察前 2 件写入、第 3 件失败；点“立即续作”，批次号不变</li>
            <li>用“并发演练”按钮让两窗口同编一批，只一份拿到 FX 号，另一份留草稿提示</li>
            <li>在实验室面板修订浮选结果，探方统计立即标失配并挡住封存，重算后放行</li>
          </ol>
          <button onClick={reset}>↺ 重置全部演练数据</button>
        </div>
      </section>

      <SquaresPanel engine={lab} api={api} />
      <BagLedger api={api} />

      <section className="windows-grid">
        <FieldWindow engine={winA} other={winB} armFailure={armA} setArmFailure={setArmA} />
        <FieldWindow engine={winB} other={winA} armFailure={armB} setArmFailure={setArmB} />
      </section>

      <LabPanel engine={lab} api={api} />
    </main>
  );
}
