import { useEffect, useMemo, useState } from 'react';
import { errorCode, getReport, listReports, getAgents } from '../data/api';
import { AGENT_CLI_LIST } from '../utils/agents';
import type { ReportEntry, ReportsList, LocalAgent } from '../data/api';
import { lookupError } from '../data/errorCatalog';
import { mdToHtml, MURMUR_MD_CSS } from '../utils/markdown';
import { useBatchTracker } from '../components/extras/BatchTracker';
import { maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { PageHeader } from '../shell/PageHeader';
import { Button, Callout, EmptyState, ErrorState, Skeleton, SkeletonText, cx } from '../ui';
import { IconChevronLeft, IconReport, IconSearch, IconSparkle } from '../ui/icons';
import type { Tone } from '../ui';
import './Reports.css';

interface Props {
  onBack: () => void;
}

export function ReportsPage(props: Props) {
  // onBack is unused since the app shell's nav replaced the page's own ← 返回.
  void props;
  void usePrivacy();
  const [list, setList] = useState<ReportsList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState<{ path: string; content: string } | null>(null);
  const [activeLoading, setActiveLoading] = useState(false);
  // Narrow windows show either the list or the reader; true once the user
  // opens a report (the auto-picked first one doesn't count).
  const [reading, setReading] = useState(false);
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const [selectedCli, setSelectedCli] = useState<string>('');
  const [parallel, setParallel] = useState(2);
  const [batchOpen, setBatchOpen] = useState(false);
  // Shown inside the batch panel instead of window.alert().
  const [batchNotice, setBatchNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const [refreshedBatchPid, setRefreshedBatchPid] = useState<number | null>(null);
  const { batch, status: batchStatus, startBatchJob } = useBatchTracker();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    listReports()
      .then(r => { if (!cancelled) setList(r); })
      .catch(e => { if (!cancelled) setError(e); });
    return () => { cancelled = true; };
  }, [loadNonce]);

  useEffect(() => {
    getAgents().then(setAgents).catch(() => { /* no local agents available */ });
  }, []);

  useEffect(() => {
    if (selectedCli || agents.length === 0) return;
    const preferred = agents.find(a => a.cli === 'claude') || agents.find(a => a.cli === 'codex') || agents[0];
    if (preferred) setSelectedCli(preferred.cli);
  }, [agents, selectedCli]);

  // Refresh the list when a background batch finishes, even if it was started
  // from the graph page before the user came here.
  useEffect(() => {
    if (!batch || !batchStatus || batchStatus.running || refreshedBatchPid === batch.pid) return;
    setRefreshedBatchPid(batch.pid);
    listReports().then(setList).catch(() => { /* keep current list visible */ });
  }, [batch, batchStatus, refreshedBatchPid]);

  async function launchBatch(
    mode: 'top' | 'all' | 'pairs-graph',
    top: number,
    top_pairs: number,
    sample = 80,
    parallel = 2,
    force = false,
  ) {
    setBatchNotice(null);
    if (agents.length === 0) {
      setBatchNotice({ tone: 'warning', text: `没检测到本机 AI CLI（${AGENT_CLI_LIST}），请先安装其一，例如 npm install -g @anthropic-ai/claude-code` });
      return;
    }
    if (selectedCli !== 'both' && !agents.some(a => a.cli === selectedCli)) {
      setBatchNotice({ tone: 'warning', text: '请先在上面选一个本机 AI，或双引擎。' });
      return;
    }
    const cli = selectedCli;
    try {
      const r = await startBatchJob(
        { cli, mode, top, top_pairs, sample, parallel, force },
        { label: mode === 'pairs-graph' ? `朋友间 Top ${top_pairs} 对` : 'AI 关系档案批量分析' },
      );
      if (!r.ok) setBatchNotice({ tone: 'danger', text: '启动失败：' + maskText(r.error || '') });
    } catch (e: any) {
      setBatchNotice({ tone: 'danger', text: '启动失败：' + maskText(e?.message || String(e)) });
    }
  }

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

  // Auto-pick the first friend report on first load
  useEffect(() => {
    if (list && !active && list.friends.length > 0) {
      const first = list.friends[0];
      pickReport(first);
    }
  }, [list, active]);

  function openReport(entry: ReportEntry) {
    setReading(true);
    void pickReport(entry);
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
      maskText(e.name.replace(/^\d+_/, '').replace(/_/g, ' ').replace(/^(.*?)__(.*)$/, '$1 ↔ $2'));

    const tocFriends = results.filter(r => r.kind === 'friend')
      .map((r, i) => `<li><a href="#r${i}">${htmlEsc(cleanName(r.entry))}</a></li>`).join('\n');
    const startPairsIdx = results.findIndex(r => r.kind === 'pair');
    const tocPairs = results.filter(r => r.kind === 'pair')
      .map((r, i) => `<li><a href="#r${startPairsIdx + i}">${htmlEsc(cleanName(r.entry))}</a></li>`).join('\n');

    const sections = results.map((r, i) =>
      `<section id="r${i}"><h1>${htmlEsc(cleanName(r.entry))}</h1>` +
      `<article class="murmur-md">${mdToHtml(maskText(r.content))}</article></section>`
    ).join('\n<hr/>\n');

    // The exported file is a standalone document opened outside the app, so
    // it carries its own fixed (light) palette instead of the app's tokens.
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
    const code = errorCode(error);
    const entry = lookupError(code);
    const raw = error instanceof Error ? error.message : String(error);
    return (
      <>
        <PageHeader title="AI 关系档案" />
        <ErrorState
          layout="page"
          code={code ?? undefined}
          title={entry?.title ?? '报告列表没能加载'}
          reason={entry?.reason ?? '读取 AI 关系档案目录时本地服务返回了错误。'}
          fixes={entry ? [entry.fix] : ['点「重试」再读一次', '还不行就到「设置」里复制诊断信息反馈给我们']}
          onRetry={() => setLoadNonce(n => n + 1)}
          details={raw ? <pre>{maskText(raw)}</pre> : undefined}
        />
      </>
    );
  }
  if (!list) {
    return <ReportsSkeleton />;
  }
  const noReports = list.friends.length === 0 && list.pairs.length === 0;
  const noMatch = !noReports && filteredFriends.length === 0 && filteredPairs.length === 0;
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
  const extraAgents = agents.filter(a => a.cli !== 'claude' && a.cli !== 'codex');

  return (
    <div className={cx('app-fill reports-page', reading && 'is-reading', noReports && 'is-empty')}>
      <PageHeader title="AI 关系档案"
        subtitle={`朋友档案 ${list.friends.length} 份 · 关系档案 ${list.pairs.length} 份`} />
      {/* List pane */}
      <div className="reports-side">
        <div className="reports-tools">
          {!noReports && (
            <label className="reports-filter">
              <IconSearch size={13} />
              <input
                type="search"
                placeholder="筛选..."
                aria-label="按名字筛选报告"
                value={filter}
                onChange={e => setFilter(e.target.value)}
              />
            </label>
          )}
          {!noReports && (
            <Button variant="primary" size="sm" block onClick={exportAllHtml}>📦 导出全套 HTML</Button>
          )}
          <Button size="sm" block aria-expanded={batchOpen}
            className={cx('reports-batch-toggle', batchRunning && 'is-running')}
            icon={batchRunning ? <span className="ui-spinner" aria-hidden="true" /> : undefined}
            onClick={() => setBatchOpen(o => !o)}>
            🤖 批量分析{batchRunning ? '（跑着）' : ''}
          </Button>
          {batchOpen && (
            <div className="reports-batch">
              <div className="reports-batch__label">模型：</div>
              <div className="reports-batch__choices">
                <ChoiceBtn label="Claude" active={selectedCli === 'claude'} disabled={!hasClaude || batchRunning}
                  sub={hasClaude ? '已检测' : '未安装'} onClick={() => setSelectedCli('claude')} />
                <ChoiceBtn label="Codex" active={selectedCli === 'codex'} disabled={!hasCodex || batchRunning}
                  sub={hasCodex ? '已检测' : '未安装'} onClick={() => setSelectedCli('codex')} />
                <ChoiceBtn label="双引擎" active={selectedCli === 'both'} disabled={!hasBoth || batchRunning}
                  sub={hasBoth ? '对照跑' : '需两者'} onClick={() => setSelectedCli('both')} />
                {extraAgents.map(a => (
                  <ChoiceBtn key={a.cli} label={a.name} active={selectedCli === a.cli} disabled={batchRunning}
                    sub="已检测" onClick={() => setSelectedCli(a.cli)} />
                ))}
              </div>
              <div className="reports-batch__label">速度：</div>
              <div className="reports-batch__choices">
                <ChoiceBtn label="稳妥" active={parallel === 1} disabled={batchRunning} sub="1 路" onClick={() => setParallel(1)} />
                <ChoiceBtn label="标准" active={parallel === 2} disabled={batchRunning} sub="2 路" onClick={() => setParallel(2)} />
                <ChoiceBtn label="快跑" active={parallel === 4} disabled={batchRunning} sub="4 路" onClick={() => setParallel(4)} />
              </div>
              <div className="reports-batch__label">选个量级：</div>
              <div className="reports-batch__sizes">
                <BatchBtn label="小样本自检" sub="2 朋友 + 2 对 · sample 12" onClick={() => launchBatch('top', 2, 2, 12, 1, true)} disabled={batchRunning} />
                <BatchBtn label="Top 10 朋友 + 10 对" sub="稳妥跑一轮" onClick={() => launchBatch('top', 10, 10, 80, parallel)} disabled={batchRunning} />
                <BatchBtn label="Top 30 朋友 + 30 对" sub="更完整" onClick={() => launchBatch('top', 30, 30, 80, parallel)} disabled={batchRunning} />
                <BatchBtn label="全部朋友 + Top 30 对" sub="覆盖本人关系" onClick={() => launchBatch('all', 0, 30, 80, parallel)} disabled={batchRunning} primary />
                <BatchBtn label="全部朋友 + 全部朋友间" sub="最完整" onClick={() => launchBatch('all', 0, 0, 80, parallel)} disabled={batchRunning} />
                <BatchBtn label="只朋友间 (按图权重)" sub="补 pair 报告" onClick={() => launchBatch('pairs-graph', 0, 40, 80, parallel)} disabled={batchRunning} />
              </div>
              {batchNotice && (
                <Callout compact tone={batchNotice.tone} className="reports-batch__notice">{batchNotice.text}</Callout>
              )}
              {batch?.pid && batchStatus && (
                <div className="reports-run" role="status">
                  <div className="reports-run__state">
                    {batchStatus.running ? `⏳ PID ${batch.pid} 跑着` : '✅ 完成'}
                  </div>
                  <div className="et-num reports-run__progress">
                    朋友 {friendProgress} · 朋友间 {pairProgress}
                  </div>
                  {issueText && <div className="reports-run__issue">{issueText}</div>}
                  {batchStatus.last_stage && (
                    <div className="reports-run__stage">{maskText(batchStatus.last_stage)}</div>
                  )}
                  <pre className="reports-run__log">{maskText(batchStatus.log_tail || '(等输出...)')}</pre>
                </div>
              )}
            </div>
          )}
        </div>
        <nav className="reports-list" aria-label="报告列表">
          {noMatch && (
            <div className="reports-list__empty">没有名字包含「{maskText(filter)}」的报告</div>
          )}
          {filteredFriends.length > 0 && (
            <>
              <div className="et-eyebrow reports-list__group">
                个人档案 · {filteredFriends.length}
              </div>
              {filteredFriends.map(r => (
                <ReportItem key={r.path} entry={r} active={active?.path === r.path} onClick={() => openReport(r)} />
              ))}
            </>
          )}
          {filteredPairs.length > 0 && (
            <>
              <div className="et-eyebrow reports-list__group reports-list__group--later">
                朋友间 · {filteredPairs.length}
              </div>
              {filteredPairs.map(r => (
                <ReportItem key={r.path} entry={r} active={active?.path === r.path} onClick={() => openReport(r)} />
              ))}
            </>
          )}
        </nav>
      </div>

      {/* Reader pane */}
      <div className="reports-main">
        {!noReports && (
          <Button variant="ghost" size="sm" className="reports-back" icon={<IconChevronLeft size={15} />}
            onClick={() => setReading(false)}>报告列表</Button>
        )}
        {noReports && (
          <EmptyState
            icon={<IconReport size={26} />}
            title="还没有 AI 关系档案"
            description="让本机的 AI（Claude、Codex 等）读一读你和朋友们的聊天，写成一份份关系档案。数据只在这台电脑上处理。"
            actions={!batchOpen && (
              <Button variant="primary" icon={<IconSparkle size={15} />} onClick={() => setBatchOpen(true)}>
                打开批量分析
              </Button>
            )}
          />
        )}
        {!noReports && !active && !activeLoading && (
          <div className="et-meta reports-pick">选一份报告开始阅读</div>
        )}
        {activeLoading && (
          <div className="reports-reader-skel" aria-busy="true" aria-label="正在打开报告">
            <Skeleton width="46%" height={30} />
            <SkeletonText lines={5} lastLineWidth="70%" />
            <SkeletonText lines={4} lastLineWidth="40%" />
          </div>
        )}
        {active && !activeLoading && (
          <article
            className="murmur-md reports-article"
            dangerouslySetInnerHTML={{ __html: mdToHtml(maskText(active.content)) }}
          />
        )}
      </div>

      <style>{MURMUR_MD_CSS}</style>
    </div>
  );
}

function ReportsSkeleton() {
  return (
    <div className="app-fill reports-page" aria-busy="true">
      <PageHeader title="AI 关系档案" />
      <div className="reports-side" aria-hidden="true">
        <div className="reports-tools">
          <Skeleton height={32} radius={8} />
          <Skeleton height={30} radius={8} />
          <Skeleton height={30} radius={8} />
        </div>
        <div className="reports-list__skel">
          <Skeleton width={90} height={10} />
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="reports-list__skel-item">
              <Skeleton width={`${70 - (i % 3) * 12}%`} height={13} />
              <Skeleton width={44} height={9} />
            </div>
          ))}
        </div>
      </div>
      <div className="reports-main" aria-label="正在加载报告列表">
        <div className="reports-reader-skel">
          <Skeleton width="46%" height={30} />
          <SkeletonText lines={5} lastLineWidth="70%" />
          <SkeletonText lines={4} lastLineWidth="40%" />
        </div>
      </div>
    </div>
  );
}

function ChoiceBtn({ label, sub, active, disabled, onClick }: {
  label: string; sub: string; active: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" className="reports-choice" aria-pressed={active} onClick={onClick} disabled={disabled}>
      <span className="reports-choice__label">{label}</span>
      <span className="reports-choice__sub">{sub}</span>
    </button>
  );
}

function BatchBtn({ label, sub, onClick, disabled, primary }: {
  label: string; sub: string; onClick: () => void; disabled?: boolean; primary?: boolean;
}) {
  return (
    <button type="button" className={cx('reports-size', primary && 'is-primary')} onClick={onClick} disabled={disabled}>
      <span className="reports-size__label">{label}</span>
      <span className="reports-size__sub">{sub}</span>
    </button>
  );
}

function ReportItem({ entry, active, onClick }: { entry: ReportEntry; active: boolean; onClick: () => void }) {
  // Extract a clean display name: "01_friend_a" → "朋友A", "02_朋友B__friend_c" → "朋友B ↔ friend_c"
  const cleaned = maskText(entry.name.replace(/^\d+_/, '').replace(/_/g, ' ').replace(/^(.*?)__(.*)$/, '$1 ↔ $2'));
  return (
    <button type="button" className="reports-item" aria-current={active || undefined} onClick={onClick}>
      <span className="reports-item__name">{cleaned}</span>
      <span className="reports-item__size">{(entry.size / 1024).toFixed(1)} KB</span>
    </button>
  );
}
