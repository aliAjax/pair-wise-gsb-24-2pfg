import { useStore } from "../store";
import { resetServer } from "../server";
import { formatTime } from "../sync";

export function Header() {
  const store = useStore();
  const waiting = store.outbox.filter((o) => o.status === "waiting" || o.status === "error").length;
  const conflicts = Object.values(store.snap.samples).filter((s) => s.stratumStatus === "conflict").length;
  const pending = new Set(
    Object.values(store.snap.batches)
      .flatMap((b) => Object.values(b.results))
      .filter((r) => r.status === "pending")
      .map((r) => r.bagNo)
  ).size;

  return (
    <section className="hero">
      <div>
        <p className="eyebrow">hxwl-10 · 探方—土样—浮选批次 续作档案</p>
        <h1>考古现场记录</h1>
        <p className="subtitle">
          现场离线登记、回连按袋号逐件合并；现场与实验室地层原值不一致时双方留档待领队核对；
          浮选结果变化使引用探方统计失效并挡住封存；双窗口同批次提交乐观并发只放行一份。
        </p>
        <div className="hero-actions">
          <button className={`conn-toggle ${store.online ? "is-online" : "is-offline"}`} onClick={store.toggleOnline}>
            切到{store.online ? "离线" : "在线"}
          </button>
          <button
            onClick={() => {
              resetServer();
              localStorage.removeItem("hxwl10.stats.v1");
              location.reload();
            }}
          >
            重置服务器档案
          </button>
          <span className={`conn-dot ${store.online ? "online" : "offline"}`}>{store.online ? "在线" : "离线"}</span>
        </div>
      </div>
      <div className="stack-card">
        <span>本窗口客户端</span>
        <strong>{store.clientId}</strong>
        <div className="kpi-row">
          <div><em>{waiting}</em><span>待续传操作</span></div>
          <div><em>{pending}</em><span>未回填检测</span></div>
          <div><em>{conflicts}</em><span>地层待核对</span></div>
        </div>
      </div>
    </section>
  );
}

export function LogPanel() {
  const store = useStore();
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>事件流</p>
          <h2>本地与服务器日志</h2>
        </div>
      </div>
      <div className="log-list">
        {store.logs.length === 0 && <p className="hint">暂无事件。提交操作或在另一窗口写入后，这里会实时更新。</p>}
        {store.logs.map((l) => (
          <div key={l.id} className="log-line">
            <code>{formatTime(l.at)}</code>
            <span className={`log-kind log-kind-${l.kind.startsWith("server") ? "server" : l.kind}`}>{l.kind}</span>
            <span>{l.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
