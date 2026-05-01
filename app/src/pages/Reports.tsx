import { useEffect, useMemo, useState } from 'react';
import { getReport, listReports, startBatch, getBatchStatus, getAgents } from '../data/api';
import type { ReportEntry, ReportsList, LocalAgent } from '../data/api';
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
  const [batch, setBatch] = useState<{ pid: number; log_path: string } | null>(null);
  const [batchStatus, setBatchStatus] = useState<{ running: boolean; n_friends: number; n_pairs: number; log_tail: string } | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);

  useEffect(() => {
    listReports().then(setList).catch(e => setError(e?.message || String(e)));
    getAgents().then(setAgents).catch(() => {});
  }, []);

  // Poll batch status while running
  useEffect(() => {
    if (!batch) return;
    const tick = async () => {
      try {
        const s = await getBatchStatus(batch.pid, batch.log_path);
        setBatchStatus(s);
        if (!s.running) {
          // Refresh report list
          const fresh = await listReports();
          setList(fresh);
        }
      } catch {}
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [batch]);

  async function launchBatch(mode: 'top' | 'all' | 'pairs-graph', top: number, top_pairs: number) {
    if (agents.length === 0) {
      alert('没检测到 claude / codex CLI，请先安装 (npm install -g @anthropic-ai/claude-code)');
      return;
    }
    const cli = (agents[0].cli as 'claude' | 'codex');
    try {
      const r = await startBatch({ cli, mode, top, top_pairs });
      if (!r.ok || !r.pid || !r.log_path) {
        alert('启动失败：' + (r.error || ''));
        return;
      }
      setBatch({ pid: r.pid, log_path: r.log_path });
      setBatchStatus({ running: true, n_friends: 0, n_pairs: 0, log_tail: '启动中…' });
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
  }, [list]);

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

    const cleanName = (e: ReportEntry) =>
      e.name.replace(/^\d+_/, '').replace(/_/g, ' ').replace(/^(.*?)__(.*)$/, '$1 ↔ $2');

    const tocFriends = results.filter(r => r.kind === 'friend')
      .map((r, i) => `<li><a href="#r${i}">${cleanName(r.entry)}</a></li>`).join('\n');
    const startPairsIdx = results.findIndex(r => r.kind === 'pair');
    const tocPairs = results.filter(r => r.kind === 'pair')
      .map((r, i) => `<li><a href="#r${startPairsIdx + i}">${cleanName(r.entry)}</a></li>`).join('\n');

    const sections = results.map((r, i) =>
      `<section id="r${i}"><h1>${cleanName(r.entry)}</h1>` +
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
  if (list.friends.length === 0 && list.pairs.length === 0) {
    return (
      <div style={{ padding: 60, textAlign: 'center', maxWidth: 700, margin: '0 auto' }}>
        <button onClick={onBack} style={{ all: 'unset', cursor: 'pointer', color: 'var(--et-mute)' }}>← 返回</button>
        <div className="et-h2" style={{ marginTop: 20 }}>还没有 AI 分析报告</div>
        <div className="et-meta" style={{ marginTop: 12, lineHeight: 1.7 }}>
          先在 Murmur 仓库根目录的终端跑：<br/>
          <code style={{ display: 'inline-block', marginTop: 8, padding: '8px 14px',
            background: 'var(--et-paper-2)', borderRadius: 6, fontFamily: 'var(--et-mono)' }}>
            python3 cli/batch_analyze.py --top 10
          </code><br/>
          约 8-10 分钟后报告会出现在这里。
        </div>
      </div>
    );
  }

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
            background: batch?.pid && batchStatus?.running ? 'var(--et-orange-2)' : 'var(--et-ink)',
            color: '#fff', fontSize: 12, fontWeight: 600, textAlign: 'center',
          }}>🤖 批量分析{batch?.pid && batchStatus?.running ? ' (跑着)' : ''}</button>
          {batchOpen && (
            <div style={{
              padding: '10px 12px', background: 'var(--et-paper-2)',
              border: '0.5px solid var(--et-line-2)', borderRadius: 8,
              fontSize: 11, color: 'var(--et-ink-soft)', lineHeight: 1.6,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>选个量级：</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <BatchBtn label="顶 10 朋友" sub="≈ 30 分钟" onClick={() => launchBatch('top', 10, 10)} disabled={!!batch?.pid && batchStatus?.running} />
                <BatchBtn label="顶 30 朋友 + 30 对" sub="≈ 1.5 小时" onClick={() => launchBatch('top', 30, 30)} disabled={!!batch?.pid && batchStatus?.running} />
                <BatchBtn label="全部 100 + 30 对" sub="≈ 5 小时 · token 多" onClick={() => launchBatch('all', 100, 30)} disabled={!!batch?.pid && batchStatus?.running} primary />
                <BatchBtn label="只朋友间 (按图权重)" sub="补全 pair 报告" onClick={() => launchBatch('pairs-graph', 0, 40)} disabled={!!batch?.pid && batchStatus?.running} />
              </div>
              {batch?.pid && batchStatus && (
                <div style={{ marginTop: 10, padding: '8px 10px', background: 'var(--et-paper)',
                  borderRadius: 6, border: '0.5px solid var(--et-line-2)' }}>
                  <div style={{ fontSize: 11, color: 'var(--et-mute)' }}>
                    {batchStatus.running ? `⏳ PID ${batch.pid} 跑着` : '✅ 完成'}
                  </div>
                  <div className="et-num" style={{ fontSize: 13, marginTop: 4 }}>
                    {batchStatus.n_friends} friends · {batchStatus.n_pairs} pairs
                  </div>
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
        {!active && <div className="et-meta" style={{ textAlign: 'center', marginTop: 80 }}>选一份报告开始阅读</div>}
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
