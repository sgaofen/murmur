/* AI 关系档案 (#/reports) — every saved report, and the batch runner that writes them.
 *
 *   45 档案   the report list (friends, then pairs) + export
 *   46 批量分析 pick a local AI, a speed and a size; live progress
 *   48 阅读   the selected report in the shared long-form reader
 *
 * The page is `.app-fill`: the list and the reader scroll on their own. On
 * narrow windows the list and the reader take turns (master / detail).
 * Styles: ./Reports.css (prefix rp-) + ./extras/ReportReader.css. */
import { useEffect, useMemo, useState } from 'react';
import { errorCode, getReport, listReports, getAgents } from '../data/api';
import { AGENT_CLI_LIST } from '../utils/agents';
import type { ReportEntry, ReportsList, LocalAgent } from '../data/api';
import { lookupError } from '../data/errorCatalog';
import { mdToHtml } from '../utils/markdown';
import { useBatchTracker } from '../components/extras/BatchTracker';
import { maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { PageHeader } from '../shell/PageHeader';
import { Button, Callout, EmptyState, ErrorState, Module, Skeleton, SkeletonText, cx } from '../ui';
import { IconChevronLeft, IconReport, IconSparkle } from '../ui/icons';
import type { Tone } from '../ui';
import { ReportReader, parseReport } from './extras/ReportReader';
import './Reports.css';

interface Props {
  onBack: () => void;
}

/** "01_朋友PB" → "朋友PB", "02_朋友AB__朋友CD" → "朋友AB ↔ 朋友CD" (masked). */
function cleanName(e: ReportEntry): string {
  return maskText(e.name.replace(/\.md$/i, '').replace(/^\d+_/, '').replace(/^(.*?)__(.*)$/, '$1 ↔ $2').replace(/_/g, ' '));
}

function ageOf(mtime: number): string {
  if (!mtime) return '';
  const days = Math.floor((Date.now() - mtime * 1000) / 86400000);
  if (days < 1) return '今天';
  if (days === 1) return '昨天';
  if (days < 60) return `${days} 天前`;
  const d = new Date(mtime * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function kb(size: number): string {
  return `${(size / 1024).toFixed(1)} KB`;
}

export function ReportsPage(props: Props) {
  // onBack is unused since the app shell's nav replaced the page's own ← 返回.
  void props;
  void usePrivacy();
  const [list, setList] = useState<ReportsList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState<{ entry: ReportEntry; content: string; error?: unknown } | null>(null);
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
  const [exporting, setExporting] = useState(false);
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
    } catch (e: unknown) {
      setBatchNotice({ tone: 'danger', text: '启动失败：' + maskText(e instanceof Error ? e.message : String(e)) });
    }
  }

  async function pickReport(entry: ReportEntry) {
    setActiveLoading(true);
    try {
      const r = await getReport(entry.path);
      setActive({ entry, content: r.content });
    } catch (e: unknown) {
      setActive({ entry, content: '', error: e });
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
    if (!list || exporting) return;
    setExporting(true);
    try {
      await exportReportsHtml(list);
    } finally {
      setExporting(false);
    }
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
  const parsed = useMemo(
    () => (active && !active.error ? parseReport(maskText(active.content)) : null),
    [active],
  );

  if (error) {
    const code = errorCode(error);
    const entry = lookupError(code);
    const raw = error instanceof Error ? error.message : String(error);
    return (
      <div className="rp-state">
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
      </div>
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
  const total = friendTotal + pairTotal;
  const pct = total > 0 ? Math.min(100, Math.round(((friendDone + pairDone) / total) * 100)) : (batchStatus?.running ? 0 : 100);
  const issueText = batchStatus && (batchStatus.crashed || (batchStatus.failures || 0) > 0 || (batchStatus.skipped || 0) > 0)
    ? `${batchStatus.crashed ? '异常退出 · ' : ''}失败 ${batchStatus.failures || 0} · 跳过 ${batchStatus.skipped || 0}`
    : '';
  const hasClaude = agents.some(a => a.cli === 'claude');
  const hasCodex = agents.some(a => a.cli === 'codex');
  const hasBoth = hasClaude && hasCodex;
  const extraAgents = agents.filter(a => a.cli !== 'claude' && a.cli !== 'codex');
  const cliLabel = selectedCli === 'both' ? '双引擎'
    : selectedCli === 'claude' ? 'Claude' : selectedCli === 'codex' ? 'Codex'
      : agents.find(a => a.cli === selectedCli)?.name ?? '未选择';
  const batchState = batchRunning ? 'RUN' : batch?.pid && batchStatus ? 'DONE' : 'IDLE';

  const back = (
    <Button size="sm" variant="ghost" className="rp-back" icon={<IconChevronLeft size={14} />}
      onClick={() => setReading(false)}>报告列表</Button>
  );

  let reader;
  if (noReports) {
    reader = (
      <div className="rp-pane rp-pane--state">
        <EmptyState
          className="rp-empty"
          icon={<IconReport size={24} />}
          label="REPORTS · 00"
          title="还没有 AI 关系档案"
          description="让本机的 AI（Claude、Codex 等）读一读你和朋友们的聊天，写成一份份关系档案。数据只在这台电脑上处理。"
          actions={!batchOpen && (
            <Button variant="primary" icon={<IconSparkle size={15} />} onClick={() => setBatchOpen(true)}>
              打开批量分析
            </Button>
          )}
        />
      </div>
    );
  } else if (activeLoading) {
    reader = (
      <div className="rp-pane" aria-busy="true" aria-label="正在打开报告">
        <div className="rp-pane__bar"><span className="rp-pane__id">48</span><span className="rp-pane__t">阅读</span><span>OPENING…</span>{back}</div>
        <div className="rp-reader-skel">
          <Skeleton width={120} height={10} />
          <Skeleton width="52%" height={30} />
          <SkeletonText lines={5} lastLineWidth="70%" />
          <SkeletonText lines={4} lastLineWidth="40%" />
        </div>
      </div>
    );
  } else if (active?.error) {
    const e = active.error;
    const code = errorCode(e);
    const entry = lookupError(code);
    reader = (
      <div className="rp-pane">
        <div className="rp-pane__bar"><span className="rp-pane__id">48</span><span className="rp-pane__t">阅读</span><span>ERROR</span>{back}</div>
        <ErrorState
          code={code ?? undefined}
          title={entry?.title ?? `「${cleanName(active.entry)}」没能打开`}
          reason={entry?.reason ?? '读取这份报告文件时本地服务返回了错误。'}
          fixes={entry ? [entry.fix] : ['点「重试」再读一次', '文件可能被移走了：重新跑一次批量分析会重新生成']}
          onRetry={() => void pickReport(active.entry)}
          details={<pre>{maskText(e instanceof Error ? e.message : String(e))}</pre>}
        />
      </div>
    );
  } else if (active && parsed) {
    const isPair = active.entry.path.startsWith('pairs/');
    reader = (
      <div className="rp-pane rp-pane--reader">
        <ReportReader
          id="48"
          label="阅读"
          modal={false}
          title={parsed.title ? parsed.title : cleanName(active.entry)}
          meta={<>{isPair ? '朋友间' : '个人档案'} · <b>{kb(active.entry.size)}</b>{active.entry.mtime ? <> · {ageOf(active.entry.mtime)}</> : null} · 本地文件 {maskText(active.entry.path)}</>}
          sections={parsed.sections}
          raw={parsed.sections.length ? undefined : maskText(active.content)}
          actions={back}
        />
      </div>
    );
  } else {
    reader = (
      <div className="rp-pane rp-pane--state">
        <EmptyState className="rp-empty" icon={<IconReport size={24} />} label="READ · —" title="选一份报告开始阅读" description="左边列表里的每一份，都是本机 AI 读完聊天后写下的。" />
      </div>
    );
  }

  return (
    <div className={cx('app-fill rp-page', reading && 'is-reading', noReports && 'is-empty')}>
      <PageHeader title="AI 关系档案"
        subtitle={`朋友档案 ${list.friends.length} 份 · 关系档案 ${list.pairs.length} 份`} />
      <div className="rp-rack ui-rack">
        <div className="rp-col">
          <Module
            id="45" title="档案" en="REPORTS" className="rp-m45" bodyClassName="rp-m45__body"
            right={<span className="rp-hd-n">F {String(list.friends.length).padStart(2, '0')} · P {String(list.pairs.length).padStart(2, '0')}</span>}
          >
            {!noReports && (
              <div className="rp-find">
                <label className="ui-field rp-find__f">
                  <span className="ui-field__prompt" aria-hidden="true">/</span>
                  <input
                    type="search"
                    placeholder="筛选名字"
                    aria-label="按名字筛选报告"
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                  />
                </label>
              </div>
            )}
            <nav className="rp-list" aria-label="报告列表">
              {noReports && <div className="rp-note">还没有报告。用下面的「批量分析」让本机 AI 写第一批。</div>}
              {noMatch && <div className="rp-note">没有名字包含「{maskText(filter)}」的报告</div>}
              {filteredFriends.length > 0 && (
                <>
                  <div className="rp-grp"><span className="ui-label">FRIENDS<b>个人档案</b></span><span>{String(filteredFriends.length).padStart(2, '0')}</span></div>
                  {filteredFriends.map((r, i) => (
                    <ReportItem key={r.path} no={i + 1} entry={r} active={active?.entry.path === r.path} onClick={() => openReport(r)} />
                  ))}
                </>
              )}
              {filteredPairs.length > 0 && (
                <>
                  <div className="rp-grp"><span className="ui-label">PAIRS<b>朋友间</b></span><span>{String(filteredPairs.length).padStart(2, '0')}</span></div>
                  {filteredPairs.map((r, i) => (
                    <ReportItem key={r.path} no={i + 1} entry={r} active={active?.entry.path === r.path} onClick={() => openReport(r)} />
                  ))}
                </>
              )}
            </nav>
            {!noReports && (
              <div className="rp-export">
                <Button size="sm" block loading={exporting} onClick={exportAllHtml}>导出全套 HTML</Button>
                <span className="rp-export__s">{list.friends.length + list.pairs.length} 份合成一个文件</span>
              </div>
            )}
          </Module>

          <Module
            id="46" title="批量分析" en="BATCH" className={cx('rp-m46', batchOpen && 'is-open')}
            right={<span className={cx('rp-state-k', batchRunning && 'is-run')}><i className={cx('ui-led', !batchRunning && 'is-off', batchRunning && 'is-pulse')} />{batchState}</span>}
          >
            <div className="rp-bt-sum">
              <div className="rp-bt-sum__t">
                {batchRunning
                  ? <>PID <b>{batch?.pid}</b> 正在跑 · 朋友 <b>{friendProgress}</b> · 朋友间 <b>{pairProgress}</b></>
                  : <>本机 AI · <b>{agents.length ? cliLabel : '未检测到'}</b> · <b>{parallel}</b> 路并行</>}
              </div>
              <Button size="sm" variant={batchOpen ? 'ghost' : 'secondary'} aria-expanded={batchOpen}
                onClick={() => setBatchOpen(o => !o)}>
                {batchOpen ? '收起' : batchRunning ? '查看进度' : '配置并运行'}
              </Button>
            </div>
            {batchRunning && (
              <div className="rp-meter" aria-hidden="true"><i style={{ width: `${Math.max(2, pct)}%` }} /></div>
            )}
            {batchOpen && (
              <div className="rp-bt">
                <div className="rp-bt__k ui-label">MODEL<b>模型</b></div>
                <div className="rp-opts">
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
                <div className="rp-bt__k ui-label">SPEED<b>速度</b></div>
                <div className="rp-opts">
                  <ChoiceBtn label="稳妥" active={parallel === 1} disabled={batchRunning} sub="1 路" onClick={() => setParallel(1)} />
                  <ChoiceBtn label="标准" active={parallel === 2} disabled={batchRunning} sub="2 路" onClick={() => setParallel(2)} />
                  <ChoiceBtn label="快跑" active={parallel === 4} disabled={batchRunning} sub="4 路" onClick={() => setParallel(4)} />
                </div>
                <div className="rp-bt__k ui-label">SIZE<b>选个量级，点一下就开始</b></div>
                <div className="rp-sizes">
                  <BatchBtn no="01" label="小样本自检" sub="2 朋友 + 2 对 · sample 12" onClick={() => launchBatch('top', 2, 2, 12, 1, true)} disabled={batchRunning} />
                  <BatchBtn no="02" label="Top 10 朋友 + 10 对" sub="稳妥跑一轮" onClick={() => launchBatch('top', 10, 10, 80, parallel)} disabled={batchRunning} />
                  <BatchBtn no="03" label="Top 30 朋友 + 30 对" sub="更完整" onClick={() => launchBatch('top', 30, 30, 80, parallel)} disabled={batchRunning} />
                  <BatchBtn no="04" label="全部朋友 + Top 30 对" sub="覆盖本人关系" onClick={() => launchBatch('all', 0, 30, 80, parallel)} disabled={batchRunning} primary />
                  <BatchBtn no="05" label="全部朋友 + 全部朋友间" sub="最完整" onClick={() => launchBatch('all', 0, 0, 80, parallel)} disabled={batchRunning} />
                  <BatchBtn no="06" label="只朋友间 (按图权重)" sub="补 pair 报告" onClick={() => launchBatch('pairs-graph', 0, 40, 80, parallel)} disabled={batchRunning} />
                </div>
                {batchNotice && (
                  <Callout compact tone={batchNotice.tone} className="rp-bt__notice">{batchNotice.text}</Callout>
                )}
                {batch?.pid && batchStatus && (
                  <div className="rp-run" role="status">
                    <div className="rp-run__top">
                      <span className="rp-run__state">{batchStatus.running ? `PID ${batch.pid} 跑着` : '完成'}</span>
                      <span className="rp-run__pct">{pct}%</span>
                    </div>
                    <div className="rp-run__progress">朋友 {friendProgress} · 朋友间 {pairProgress}</div>
                    {issueText && <div className="rp-run__issue">{issueText}</div>}
                    {batchStatus.last_stage && (
                      <div className="rp-run__stage">{maskText(batchStatus.last_stage)}</div>
                    )}
                    <pre className="rp-run__log">{maskText(batchStatus.log_tail || '(等输出...)')}</pre>
                  </div>
                )}
              </div>
            )}
          </Module>
        </div>
        {reader}
      </div>
    </div>
  );
}

function ReportsSkeleton() {
  return (
    <div className="app-fill rp-page" aria-busy="true">
      <PageHeader title="AI 关系档案" />
      <div className="rp-rack ui-rack">
        <div className="rp-col" aria-hidden="true">
          <Module id="45" title="档案" en="REPORTS" className="rp-m45">
            <div className="rp-skel">
              <Skeleton height={30} />
              <Skeleton width={110} height={10} />
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="rp-skel__row">
                  <Skeleton width={`${68 - (i % 3) * 12}%`} height={12} />
                  <Skeleton width={44} height={9} />
                </div>
              ))}
            </div>
          </Module>
          <Module id="46" title="批量分析" en="BATCH" className="rp-m46">
            <div className="rp-skel"><Skeleton height={12} width="70%" /></div>
          </Module>
        </div>
        <div className="rp-pane" aria-label="正在加载报告列表">
          <div className="rp-pane__bar"><span className="rp-pane__id">48</span><span className="rp-pane__t">阅读</span><span>LOADING…</span></div>
          <div className="rp-reader-skel">
            <Skeleton width={120} height={10} />
            <Skeleton width="52%" height={30} />
            <SkeletonText lines={5} lastLineWidth="70%" />
            <SkeletonText lines={4} lastLineWidth="40%" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ChoiceBtn({ label, sub, active, disabled, onClick }: {
  label: string; sub: string; active: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" className="rp-opt" aria-pressed={active} onClick={onClick} disabled={disabled}>
      <span className="rp-opt__r" aria-hidden="true" />
      <span className="rp-opt__l">{label}</span>
      <span className="rp-opt__s">{sub}</span>
    </button>
  );
}

function BatchBtn({ no, label, sub, onClick, disabled, primary }: {
  no: string; label: string; sub: string; onClick: () => void; disabled?: boolean; primary?: boolean;
}) {
  return (
    <button type="button" className={cx('rp-size', primary && 'is-primary')} onClick={onClick} disabled={disabled}>
      <span className="rp-size__no">{no}</span>
      <span className="rp-size__l">{label}</span>
      <span className="rp-size__s">{sub}</span>
      <span className="rp-size__go" aria-hidden="true">{primary ? 'RUN ↵' : '→'}</span>
    </button>
  );
}

function ReportItem({ no, entry, active, onClick }: { no: number; entry: ReportEntry; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className="rp-item" aria-current={active || undefined} onClick={onClick}>
      <span className="rp-item__no">{String(no).padStart(2, '0')}</span>
      <span className="rp-item__name">{cleanName(entry)}</span>
      <span className="rp-item__size">{kb(entry.size)}</span>
    </button>
  );
}

// ———————————————————————— export ————————————————————————

/** Every report in one standalone HTML file, downloaded by the browser. */
async function exportReportsHtml(list: ReportsList) {
  const friends = list.friends;
  const pairs = list.pairs;
  const all = [...friends, ...pairs];
  // Fetch all in parallel (cap ~5 concurrent to avoid hammering)
  const results: Array<{ entry: ReportEntry; content: string; kind: string }> = [];
  let inFlight = 0;
  let i = 0;
  await new Promise<void>((resolve) => {
    if (!all.length) { resolve(); return; }
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

  const tocFriends = results.filter(r => r.kind === 'friend')
    .map((r, i) => `<li><a href="#r${i}"><span>${String(i + 1).padStart(2, '0')}</span>${htmlEsc(cleanName(r.entry))}</a></li>`).join('\n');
  const startPairsIdx = results.findIndex(r => r.kind === 'pair');
  const tocPairs = results.filter(r => r.kind === 'pair')
    .map((r, i) => `<li><a href="#r${startPairsIdx + i}"><span>${String(i + 1).padStart(2, '0')}</span>${htmlEsc(cleanName(r.entry))}</a></li>`).join('\n');

  const sections = results.map((r, i) =>
    `<section id="r${i}"><div class="no">${String(i + 1).padStart(2, '0')} · ${r.kind === 'friend' ? 'FRIEND' : 'PAIR'}</div><h1>${htmlEsc(cleanName(r.entry))}</h1>` +
    `<article class="md">${mdToHtml(maskText(r.content))}</article></section>`
  ).join('\n');

  // The exported file is a standalone document opened outside the app, so
  // it carries its own fixed palette (the aluminium theme) instead of the
  // app's tokens.
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Murmur 关系档案合集</title>
<style>
:root { --bg: #D6D6D2; --panel: #EBEBE7; --ink: #111213; --ink2: #55575A; --faint: #8C8E8F; --rule: #C6C6C1; --rule2: #ADADA8; --signal: #C9EA3C; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink2);
       font: 15px/1.95 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; letter-spacing: .02em; }
.mono, .no, .toc h2, .toc span, footer { font-family: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace; }
main { max-width: 860px; margin: 24px auto; background: var(--panel); border: 1px solid var(--rule); }
header { padding: 28px 40px 22px; border-bottom: 1px solid var(--rule); }
header .mono { font-size: 10px; letter-spacing: .1em; color: var(--faint); text-transform: uppercase; }
header h1 { margin: 10px 0 0; font-size: 28px; font-weight: 400; line-height: 1.4; color: var(--ink); }
.toc { padding: 18px 40px 22px; border-bottom: 1px solid var(--rule); }
.toc h2 { margin: 12px 0 6px; font-size: 10px; font-weight: 400; letter-spacing: .1em; color: var(--faint); }
.toc ul { columns: 2; column-gap: 28px; list-style: none; margin: 0; padding: 0; }
.toc li { break-inside: avoid; border-bottom: 1px solid var(--rule); }
.toc a { display: flex; gap: 10px; padding: 5px 0; color: var(--ink); text-decoration: none; font-size: 13px; line-height: 1.6; }
.toc a:hover { background: rgba(17,18,19,.05); }
.toc span { font-size: 10.5px; color: var(--faint); }
section { padding: 36px 40px 40px; border-bottom: 1px solid var(--rule2); }
.no { font-size: 10px; letter-spacing: .1em; color: var(--faint); }
section > h1 { margin: 8px 0 18px; font-size: 24px; font-weight: 400; line-height: 1.4; color: var(--ink); }
.md h1, .md h2 { margin: 1.8em 0 .6em; padding-top: 1.2em; border-top: 1px solid var(--rule); font-size: 18px; font-weight: 500; color: var(--ink); }
.md h3, .md h4 { margin: 1.6em 0 .5em; font-size: 15px; font-weight: 600; color: var(--ink); }
.md p { margin: 0 0 1.05em; }
.md strong, .md em { color: var(--ink); font-style: normal; }
.md ul { padding-left: 22px; }
.md blockquote { margin: 1.4em 0; padding: 2px 0 2px 18px; border-left: 2px solid var(--signal); color: var(--ink); }
.md code { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-size: .86em; padding: 1px 5px; background: #E1E1DC; color: var(--ink); }
.md pre { padding: 12px 14px; overflow-x: auto; background: #E1E1DC; border: 1px solid var(--rule); font-size: 12px; line-height: 1.6; }
.md pre code { padding: 0; }
.md hr { border: 0; border-top: 1px solid var(--rule); margin: 2em 0; }
.md table { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 1.6; }
.md th, .md td { padding: 7px 10px; text-align: left; border-bottom: 1px solid var(--rule); }
.md th { font-weight: 400; font-size: 11px; color: var(--faint); border-bottom-color: var(--rule2); }
.md a { color: var(--ink); }
footer { padding: 18px 40px 22px; font-size: 10px; letter-spacing: .1em; color: var(--faint); text-align: center; }
@media (max-width: 640px) { main { margin: 0; border: 0; } header, .toc, section, footer { padding-left: 20px; padding-right: 20px; } .toc ul { columns: 1; } }
</style></head>
<body><main>
<header><div class="mono">MURMUR · REPORTS · ${new Date().toISOString().slice(0, 10)}</div><h1>Murmur 关系档案合集</h1></header>
<nav class="toc">
  <h2>个人档案 · ${friends.length}</h2><ul>${tocFriends}</ul>
  <h2>朋友间关系 · ${pairs.length}</h2><ul>${tocPairs}</ul>
</nav>
${sections}
<footer>MURMUR · 你的微信社交故事 · 离线生成</footer>
</main></body></html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `murmur_reports_${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}
