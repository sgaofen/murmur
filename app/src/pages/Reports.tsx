import { useEffect, useMemo, useState } from 'react';
import { getReport, listReports, startBatch, getBatchStatus, getAgents } from '../data/api';
import type { BatchStatus, ReportEntry, ReportsList, LocalAgent } from '../data/api';
import { mdToHtml, MURMUR_MD_CSS } from '../utils/markdown';

interface Props {
  onBack: () => void;
}

export function ReportsPage({ onBack }: Props) {
  const [list, setList] = useState<ReportsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState<{ path: string; content: string } | null>(null);
  const [activeLoading, setActiveLoading] = useState(false);
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const [selectedCli, setSelectedCli] = useState<'claude' | 'codex' | 'both' | ''>('');
  const [parallel, setParallel] = useState(2);
  const [batch, setBatch] = useState<{ pid: number; log_path: string; pids?: number[]; log_paths?: string[] } | null>(null);
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);

  useEffect(() => {
    listReports().then(setList).catch(e => setError(e?.message || String(e)));
    getAgents().then(setAgents).catch(() => { /* no local agents available */ });
  }, []);

  useEffect(() => {
    if (selectedCli || agents.length === 0) return;
    const preferred = agents.find(a => a.cli === 'claude') || agents.find(a => a.cli === 'codex') || agents[0];
    if (preferred?.cli === 'claude' || preferred?.cli === 'codex') {
      setSelectedCli(preferred.cli);
    }
  }, [agents, selectedCli]);

  // Poll batch status while running
  useEffect(() => {
    if (!batch) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const s = await getBatchStatus(batch.pid, batch.log_path, batch.pids, batch.log_paths);
        setBatchStatus(s);
        if (!s.running) {
          // Refresh report list
          const fresh = await listReports();
          setList(fresh);
          return;
        }
      } catch {
        // Keep current reports visible if polling hiccups.
      }
      setTimeout(tick, 5000);
    };
    tick();
    return () => { stop = true; };
  }, [batch]);

  async function launchBatch(
    mode: 'top' | 'all' | 'pairs-graph',
    top: number,
    top_pairs: number,
    sample = 80,
    parallel = 2,
    force = false,
  ) {
    if (agents.length === 0) {
      alert('没检测到 claude / codex CLI，请先安装 (npm install -g @anthropic-ai/claude-code)');
      return;
    }
    if (selectedCli !== 'claude' && selectedCli !== 'codex' && selectedCli !== 'both') {
      alert('请选择 Claude、Codex 或双引擎');
      return;
    }
    const cli = selectedCli;
    try {
      const r = await startBatch({ cli, mode, top, top_pairs, sample, parallel, force });
      if (!r.ok || !r.pid || !r.log_path) {
        alert('启动失败：' + (r.error || ''));
        return;
      }
      setBatch({ pid: r.pid, log_path: r.log_path, pids: r.pids, log_paths: r.log_paths });
      setBatchStatus({
        running: true,
        n_friends: 0,
        n_pairs: 0,
        friends_done: 0,
        friends_total: mode === 'pairs-graph' ? 0 : top,
        pairs_done: 0,
        pairs_total: top_pairs,
        log_tail: '启动中…',
      });
    } catch (e: any) {
      alert('错误：' + (e?.message || e));
    }
  }

  // Auto-pick the first friend report on first load
  useEffect(() => {
    if (list && !active && list.friends.length > 0) {
      const first = list.friends[0];
      pickReport(first);
    }
  }, [list, active]);

  async function pickReport(entry: ReportEntry) {
    setActiveLoading(true);
    try {
      const r = await getReport(entry.path);
      setActive({ path: entry.path, content: r.content });
    } catch (e: any) {
      setActive({ path: entry.path, content: `# 加载失败\n\n${e?.message || e}` });
    } finally {
      setActiveLoading(false);
    }
  }

  async function exportAllHtml() {
    if (!list) return;
    const friends = list.friends;
    const pairs = list.pairs;
    const all = [...friends, ...pairs];
    // Fetch all in parallel (cap ~5 concurrent to avoid hammering)
    const results: Array<{ entry: ReportEntry; content: string; kind: string }> = [];
    let inFlight = 0;
    let i = 0;
    await new Promise<void>((resolve) => {
      const launch = () => {
        while (inFlight < 5 && i < all.length) {
          const entry = all[i++];
          inFlight++;
          getReport(entry.path).then(r => {
            const kind = entry.path.startsWith('friends/') ? 'friend' : 'pair';
            results.push({ entry, content: r.content, kind });
          }).catch(() => {}).finally(() => {
            inFlight--;
            if (i >= all.length && inFlight === 0) resolve();
            else launch();
          });
        }
      };
      launch();
    });

    // Sort: friends first by index, then pairs
    results.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'friend' ? -1 : 1;
      return a.entry.path.localeCompare(b.entry.path);
    });

    const htmlEsc = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    const cleanName = (e: ReportEntry) =>
      e.name.replace(/^\d+_/, '').replace(/_/g, ' ').replace(/^(.*?)__(.*)$/, '$1 ↔ $2');

    const tocFriends = results.filter(r => r.kind === 'friend')
      .map((r, i) => `<li><a href="#r${i}">${htmlEsc(cleanName(r.entry))}</a></li>`).join('\n');
    const startPairsIdx = results.findIndex(r => r.kind === 'pair');
    const tocPairs = results.filter(r => r.kind === 'pair')
      .map((r, i) => `<li><a href="#r${startPairsIdx + i}">${htmlEsc(cleanName(r.entry))}</a></li>`).join('\n');

    const sections = results.map((r, i) =>
      `<section id="r${i}"><h1>${htmlEsc(cleanName(r.entry))}</h1>` +
      `<article class="murmur-md">${mdToHtml(r.content)}</article></section>`
    ).join('\n<hr/>\n');

    const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Murmur 关系档案合集</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
       max-width: 920px; margin: 0 auto; padding: 40px 56px; color: #1A2B4A; background: #F7F1E6; line-height: 1.75; }
h1 { font-family: Georgia, "Songti SC", serif; font-size: 32px; margin: 36px 0 14px; padding-bottom: 8px; border-bottom: 1px solid rgba(26,43,74,0.15); }
.toc { background: #fff; padding: 18px 24px; border: 0.5px solid rgba(26,43,74,0.15); border-radius: 10px; margin-bottom: 30px; }
.toc h2 { margin: 0 0 8px; font-size: 16px; color: #FF6B47; }
.toc ul { columns: 2; padding-left: 22px; margin: 6px 0; }
.toc li a { color: #1A2B4A; text-decoration: none; font-size: 13px; }
.toc li a:hover { color: #FF6B47; }
section { margin: 40px 0; }
hr { border: 0; border-top: 0.5px dashed rgba(26,43,74,0.2); margin: 50px 0; }
${MURMUR_MD_CSS}
.murmur-md h1 { font-size: 22px; }
</style></head>
<body>
<h1 style="text-align:center;margin-top:0">Murmur 关系档案合集</h1>
<div class="toc">
  <h2>个人档案 (${friends.length})</h2><ul>${tocFriends}</ul>
  <h2>朋友间关系 (${pairs.length})</h2><ul>${tocPairs}</ul>
</div>
${sections}
<p style="text-align:center;margin-top:60px;color:#9C8E72;font-size:11px">— Murmur · 你的微信社交故事 · 离线生成 —</p>
</body></html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `murmur_reports_${new Date().toISOString().slice(0, 10)}.html`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  const filteredFriends = useMemo(
    () => (list?.friends || []).filter(r =>
      !filter || r.name.toLowerCase().includes(filter.toLowerCase())),
    [list, filter]
  );
  const filteredPairs = useMemo(
    () => (list?.pairs || []).filter(r =>
      !filter || r.name.toLowerCase().includes(filter.toLowerCase())),
    [list, filter]
  );

  if (error) {
    return (
      <div style={{ padding: 40 }}>
        <button onClick={onBack} style={{ all: 'unset', cursor: 'pointer', color: 'var(--et-mute)' }}>← 返回</button>
        <div style={{ marginTop: 20, color: 'var(--et-rose)' }}>加载失败：{error}</div>
      </div>
    );
  }
  if (!list) {
    return <div style={{ padding: 40 }}>加载报告列表…</div>;
  }
  const batchRunning = !!batch?.pid && !!batchStatus?.running;
  const friendDone = batchStatus?.friends_done ?? batchStatus?.n_friends ?? 0;
  const friendTotal = batchStatus?.friends_total ?? 0;
  const pairDone = batchStatus?.pairs_done ?? batchStatus?.n_pairs ?? 0;
  const pairTotal = batchStatus?.pairs_total ?? 0;
  const friendProgress = friendTotal > 0 ? `${friendDone}/${friendTotal}` : String(friendDone);
  const pairProgress = pairTotal > 0 ? `${pairDone}/${pairTotal}` : String(pairDone);
  const issueText = batchStatus && (batchStatus.crashed || (batchStatus.failures || 0) > 0 || (batchStatus.skipped || 0) > 0)
    ? `${batchStatus.crashed ? '异常退出 · ' : ''}失败 ${batchStatus.failures || 0} · 跳过 ${batchStatus.skipped || 0}`
    : '';
  const hasClaude = agents.some(a => a.cli === 'claude');
  const hasCodex = agents.some(a => a.cli === 'codex');
  const hasBoth = hasClaude && hasCodex;

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex',
      background: 'var(--et-bg)', overflow: 'hidden' }}>
      {/* Sidebar */}
      <div style={{ width: 320, borderRight: '0.5px solid var(--et-line-2)',
        display: 'flex', flexDirection: 'column', background: 'var(--et-paper)' }}>
        <div style={{ padding: '14px 18px', borderBottom: '0.5px solid var(--et-line)',
          display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={onBack} style={{ all: 'unset', cursor: 'pointer',
            fontSize: 13, color: 'var(--et-mute)' }}>← 返回</button>
          <span style={{ fontFamily: 'var(--et-serif)', fontSize: 16, fontWeight: 600, color: 'var(--et-ink)' }}>
            AI 关系档案
          </span>
        </div>
        <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            placeholder="筛选..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{
              all: 'unset', width: '100%', padding: '7px 12px', borderRadius: 8,
              border: '0.5px solid var(--et-line-2)',
              background: 'var(--et-paper-2)', fontSize: 12,
              boxSizing: 'border-box',
            }}
          />
          <button onClick={exportAllHtml} style={{
            all: 'unset', cursor: 'pointer', padding: '7px 12px', borderRadius: 8,
            background: 'var(--et-orange)', color: '#fff', fontSize: 12, fontWeight: 600,
            textAlign: 'center',
          }}>📦 导出全套 HTML</button>
          <button onClick={() => setBatchOpen(o => !o)} style={{
            all: 'unset', cursor: 'pointer', padding: '7px 12px', borderRadius: 8,
            background: batchRunning ? 'var(--et-orange-2)' : 'var(--et-ink)',
            color: '#fff', fontSize: 12, fontWeight: 600, textAlign: 'center',
          }}>🤖 批量分析{batchRunning ? ' (跑着)' : ''}</button>
          {batchOpen && (
            <div style={{
              padding: '10px 12px', background: 'var(--et-paper-2)',
              border: '0.5px solid var(--et-line-2)', borderRadius: 8,
              fontSize: 11, color: 'var(--et-ink-soft)', lineHeight: 1.6,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>模型：</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 10 }}>
                <ChoiceBtn label="Claude" active={selectedCli === 'claude'} disabled={!hasClaude || batchRunning}
                  sub={hasClaude ? '已检测' : '未安装'} onClick={() => setSelectedCli('claude')} />
                <ChoiceBtn label="Codex" active={selectedCli === 'codex'} disabled={!hasCodex || batchRunning}
                  sub={hasCodex ? '已检测' : '未安装'} onClick={() => setSelectedCli('codex')} />
                <ChoiceBtn label="双引擎" active={selectedCli === 'both'} disabled={!hasBoth || batchRunning}
                  sub={hasBoth ? '对照跑' : '需两者'} onClick={() => setSelectedCli('both')} />
              </div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>速度：</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 10 }}>
                <ChoiceBtn label="稳妥" active={parallel === 1} disabled={batchRunning} sub="1 路" onClick={() => setParallel(1)} />
                <ChoiceBtn label="标准" active={parallel === 2} disabled={batchRunning} sub="2 路" onClick={() => setParallel(2)} />
                <ChoiceBtn label="快跑" active={parallel === 4} disabled={batchRunning} sub="4 路" onClick={() => setParallel(4)} />
              </div>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>选个量级：</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <BatchBtn label="小样本自检" sub="2 朋友 + 2 对 · sample 12" onClick={() => launchBatch('top', 2, 2, 12, 1, true)} disabled={batchRunning} />
                <BatchBtn label="Top 10 朋友 + 10 对" sub="稳妥跑一轮" onClick={() => launchBatch('top', 10, 10, 80, parallel)} disabled={batchRunning} />
                <BatchBtn label="Top 30 朋友 + 30 对" sub="更完整" onClick={() => launchBatch('top', 30, 30, 80, parallel)} disabled={batchRunning} />
                <BatchBtn label="全部朋友 + Top 30 对" sub="覆盖本人关系" onClick={() => launchBatch('all', 0, 30, 80, parallel)} disabled={batchRunning} primary />
                <BatchBtn label="全部朋友 + 全部朋友间" sub="最完整" onClick={() => launchBatch('all', 0, 0, 80, parallel)} disabled={batchRunning} />
                <BatchBtn label="只朋友间 (按图权重)" sub="补 pair 报告" onClick={() => launchBatch('pairs-graph', 0, 40, 80, parallel)} disabled={batchRunning} />
              </div>
              {batch?.pid && batchStatus && (
                <div style={{ marginTop: 10, padding: '8px 10px', background: 'var(--et-paper)',
                  borderRadius: 6, border: '0.5px solid var(--et-line-2)' }}>
                  <div style={{ fontSize: 11, color: 'var(--et-mute)' }}>
                    {batchStatus.running ? `⏳ PID ${batch.pid} 跑着` : '✅ 完成'}
                  </div>
                  <div className="et-num" style={{ fontSize: 13, marginTop: 4 }}>
                    朋友 {friendProgress} · 朋友间 {pairProgress}
                  </div>
                  {issueText && <div style={{ marginTop: 4, color: 'var(--et-rose)', fontSize: 10 }}>{issueText}</div>}
                  {batchStatus.last_stage && (
                    <div style={{ marginTop: 4, color: 'var(--et-mute)', fontSize: 10 }}>{batchStatus.last_stage}</div>
                  )}
                  <pre style={{
                    margin: '8px 0 0', padding: 8, maxHeight: 120, overflowY: 'auto',
                    background: 'var(--et-paper-2)', borderRadius: 6,
                    fontSize: 10, lineHeight: 1.45, whiteSpace: 'pre-wrap',
                  }}>{batchStatus.log_tail || '(等输出...)'}</pre>
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px 16px' }}>
          {filteredFriends.length > 0 && (
            <>
              <div className="et-eyebrow" style={{ padding: '8px 10px', fontSize: 10 }}>
                个人档案 · {filteredFriends.length}
              </div>
              {filteredFriends.map(r => (
                <ReportItem key={r.path} entry={r} active={active?.path === r.path} onClick={() => pickReport(r)} />
              ))}
            </>
          )}
          {filteredPairs.length > 0 && (
            <>
              <div className="et-eyebrow" style={{ padding: '14px 10px 8px', fontSize: 10 }}>
                朋友间 · {filteredPairs.length}
              </div>
              {filteredPairs.map(r => (
                <ReportItem key={r.path} entry={r} active={active?.path === r.path} onClick={() => pickReport(r)} />
              ))}
            </>
          )}
        </div>
      </div>

      {/* Main viewer */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '40px 56px',
        background: 'var(--et-bg)' }}>
        {!active && (
          <div className="et-meta" style={{ textAlign: 'center', marginTop: 80 }}>
            {list.friends.length === 0 && list.pairs.length === 0
              ? '还没有报告，点左侧“批量分析”开始。'
              : '选一份报告开始阅读'}
          </div>
        )}
        {active && activeLoading && <div className="et-meta">加载中…</div>}
        {active && !activeLoading && (
          <article
            className="murmur-md"
            style={{
              maxWidth: 880, margin: '0 auto',
              fontFamily: 'var(--et-sans)',
              fontSize: 15, lineHeight: 1.75,
              color: 'var(--et-ink)',
            }}
            dangerouslySetInnerHTML={{ __html: mdToHtml(active.content) }}
          />
        )}
      </div>

      <style>{MURMUR_MD_CSS}</style>
    </div>
  );
}

function ChoiceBtn({ label, sub, active, disabled, onClick }: {
  label: string; sub: string; active: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      all: 'unset', cursor: disabled ? 'not-allowed' : 'pointer',
      padding: '7px 8px', borderRadius: 6,
      background: active ? 'var(--et-ink)' : 'var(--et-paper)',
      color: active ? '#fff' : 'var(--et-ink)',
      border: active ? 'none' : '0.5px solid var(--et-line-2)',
      opacity: disabled ? 0.4 : 1,
      boxSizing: 'border-box',
      minHeight: 44,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.2 }}>{label}</div>
      <div style={{ fontSize: 10, opacity: 0.72, marginTop: 3 }}>{sub}</div>
    </button>
  );
}

function BatchBtn({ label, sub, onClick, disabled, primary }: {
  label: string; sub: string; onClick: () => void; disabled?: boolean; primary?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      all: 'unset', cursor: disabled ? 'not-allowed' : 'pointer',
      padding: '7px 10px', borderRadius: 6,
      background: primary ? 'var(--et-orange)' : 'var(--et-paper)',
      color: primary ? '#fff' : 'var(--et-ink)',
      border: primary ? 'none' : '0.5px solid var(--et-line-2)',
      opacity: disabled ? 0.4 : 1,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 10, opacity: 0.7 }}>{sub}</span>
    </button>
  );
}

function ReportItem({ entry, active, onClick }: { entry: ReportEntry; active: boolean; onClick: () => void }) {
  // Extract a clean display name: "01_kevin" → "kevin", "02_高进__joyyy" → "高进 ↔ joyyy"
  const cleaned = entry.name.replace(/^\d+_/, '').replace(/_/g, ' ').replace(/^(.*?)__(.*)$/, '$1 ↔ $2');
  return (
    <button
      onClick={onClick}
      style={{
        all: 'unset', cursor: 'pointer',
        display: 'block', width: '100%',
        padding: '8px 12px', marginBottom: 2, borderRadius: 6,
        background: active ? 'var(--et-orange-soft)' : 'transparent',
        color: active ? 'var(--et-ink)' : 'var(--et-ink-soft)',
        boxSizing: 'border-box',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--et-paper-2)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{ fontSize: 13, fontWeight: active ? 600 : 500 }}>{cleaned}</div>
      <div style={{ fontSize: 10, color: 'var(--et-mute)', marginTop: 2 }}>{(entry.size / 1024).toFixed(1)} KB</div>
    </button>
  );
}
