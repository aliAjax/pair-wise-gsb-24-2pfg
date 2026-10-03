import "./styles.css";
import { StoreProvider } from "./store";
import { Header, LogPanel } from "./components/Chrome";
import { UnitsPanel } from "./components/UnitsPanel";
import { RecordsPanel } from "./components/RecordsPanel";
import { FieldPanel } from "./components/FieldPanel";
import { BatchPanel } from "./components/BatchPanel";
import { DrillPanel } from "./components/DrillPanel";

function App() {
  return (
    <StoreProvider>
      <main className="app-shell">
        <Header />
        <UnitsPanel />
        <RecordsPanel />
        <div className="two-col">
          <FieldPanel />
          <BatchPanel />
        </div>
        <DrillPanel />
        <LogPanel />
        <footer className="foot">
          本地优先演示：localStorage 模拟跨窗口共享的服务器，Web Locks 串行化写入，幂等表保证重放不重复占用批次号。
          开两个浏览器标签页可验证真实的双窗口并发与回连合并。
        </footer>
      </main>
    </StoreProvider>
  );
}

export default App;
