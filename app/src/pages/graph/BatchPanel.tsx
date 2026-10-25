/* 「批量分析关系」弹出面板：一次把关系网里最重要的 N 对朋友交给本机 AI 跑完（/api/agents/batch，mode pairs-graph）。
 * 进度来自全局的 BatchTracker（关掉面板、换页面都不影响后台的批处理）。 */
import { useEffect, useRef, useState } from 'react';
import type { BatchStatus, LocalAgent } from '../../data/api';
import type { BatchHandle } from '../../components/extras/BatchTracker';
import { AGENT_CLI_LIST } from '../../utils/agents';
import { maskText } from '../../utils/privacy';
import { Button, cx } from '../../ui';
import { IconClose } from '../../ui/icons';

export function BatchPanel({ agents, batch, status, isQQ, error, onLaunch, onReset, onClose }: {
  agents: LocalAgent[] | null;
  batch: BatchHandle | null;
  status: BatchStatus | null;
  isQQ: boolean;
  error: string | null;
  onLaunch: (topPairs: number, cli: string, parallel: number) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const list = agents || [];
  const claude = list.find(a => a.cli === 'claude');
  const codex = list.find(a => a.cli === 'codex');
  const extra = list.filter(a => a.cli !== 'claude' && a.cli !== 'codex');
  const [cli, setCli] = useState<string>(claude ? 'claude' : codex ? 'codex' : (extra[0]?.cli ?? 'claude'));
  const [parallel, setParallel] = useState(4);
  const running = !!batch && !!status?.running;
  const done = !!batch && !!status && !status.running;
  const pairDone = status?.pairs_done ?? status?.n_pairs ?? 0;
  const pairTotal = status?.pairs_total ?? 0;
  const pairProgress = pairTotal > 0 ? `${pairDone}/${pairTotal}` : String(pairDone);
  const friendDone = status?.friends_done ?? status?.n_friends ?? 0;
  const friendTotal = status?.friends_total ?? 0;
  const friendProgress = friendTotal > 0 ? `${friendDone}/${friendTotal}` : String(friendDone);
  const issues = status && (status.crashed || (status.failures || 0) > 0 || (status.skipped || 0) > 0)
    ? `${status.crashed ? '异常退出 · ' : ''}失败 ${status.failures || 0} · 跳过 ${status.skipped || 0}` : '';

  // Esc closes; focus moves in once so keyboard users land in the panel
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault(); e.stopPropagation(); closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const pick = (id: string, label: string, sub: string, ok: boolean) => (
    <button key={id} type="button" className={cx('gx-pick', cli === id && 'is-on')} disabled={!ok}
      aria-pressed={cli === id} onClick={() => setCli(id)}>
      <b>{label}</b><span>{ok ? sub : '未安装'}</span>
    </button>
  );

  return (
    <div ref={ref} className="gx-batch ui-mod" role="dialog" aria-label="批量分析关系" tabIndex={-1}>
      <header className="ui-mod__head">
        <span className="ui-mod__id">B</span>
        <span className="ui-mod__title">批量分析关系</span>
        <span className="ui-mod__en">BATCH · PAIRS</span>
        <span className="ui-mod__right">
          <button type="button" className="ui-icon-btn gx-batch__x" onClick={onClose} aria-label="关闭"><IconClose size={14} /></button>
        </span>
      </header>
      <div className="gx-batch__body">
        <p className="gx-note">
          把关系网里最重要的几对朋友一次跑完：合并群里互回、你聊天里同时提到他们{isQQ ? '' : '、朋友圈互动'}，
          让 AI 判断他们俩是什么关系、怎么变过来的、凭什么这么判断。
        </p>
        {!running && !done && (
          agents == null ? <p className="gx-note gx-note--faint">正在检测本机的 AI CLI…</p>
          : list.length === 0 ? (
            <div className="gx-callout">
              <p>没检测到本机 AI CLI（{AGENT_CLI_LIST}），批量分析跑不了。装上其中一个，例如：</p>
              <code>npm install -g @anthropic-ai/claude-code</code>
              <code>npm install -g @openai/codex</code>
            </div>
          ) : (
            <>
              <div className="ui-label gx-batch__lab">AGENT<b>谁来读（检测到 {list.length} 个）</b></div>
              <div className="gx-picks">
                {pick('claude', 'claude', 'Anthropic', !!claude)}
                {pick('codex', 'codex', 'OpenAI', !!codex)}
                {pick('both', 'both', '两个一起跑', !!claude && !!codex)}
                {extra.map(a => pick(a.cli, a.cli, a.name, true))}
              </div>
              <div className="gx-batch__par">
                <span className="ui-label">PARALLEL<b>每个 CLI 同时跑</b></span>
                <span className="gx-batch__seg">
                  {[2, 4, 6].map(n => (
                    <button key={n} type="button" className={cx('gxv-chip', parallel === n && 'is-on')} aria-pressed={parallel === n} onClick={() => setParallel(n)}>{n}</button>
                  ))}
                </span>
              </div>
              <p className="gx-note gx-note--faint">已经有报告的对会自动跳过；想全部重跑，到「报告」页删掉 pairs/ 目录。</p>
              <div className="gx-batch__opts">
                {[[10, cli === 'both' ? 'Claude + Codex 同时跑' : '大约 10 分钟'], [20, cli === 'both' ? '两套报告' : '大约 20 分钟'], [40, cli === 'both' ? '两套报告' : '大约 40 分钟']].map(([n, sub]) => (
                  <button key={n} type="button" className={cx('gx-opt', n === 20 && 'is-pri')} onClick={() => onLaunch(n as number, cli, parallel)}>
                    <b>前 {n} 对</b><span>{sub}</span>
                  </button>
                ))}
              </div>
              {error && <p className="gx-err">没能启动：{maskText(error)}</p>}
            </>
          )
        )}
        {running && status && (
          <>
            <div className="gx-batch__state">
              <span className="ui-led is-pulse" />
              <div>
                <b>正在跑 · 朋友间报告 {pairProgress}{friendTotal > 0 ? ` · 单人报告 ${friendProgress}` : ''}</b>
                <span>{issues ? issues + ' · ' : ''}关掉这个面板没关系，会在后台跑完{status.last_stage ? ` · ${maskText(status.last_stage)}` : ''}</span>
              </div>
            </div>
            <pre className="gx-batch__log">{maskText(status.log_tail || '（等输出…）')}</pre>
          </>
        )}
        {done && status && (
          <>
            <div className={cx('gx-batch__state', pairDone > 0 ? 'is-ok' : 'is-warn')}>
              <span className={cx('ui-led', pairDone === 0 && 'ui-led--warn')} />
              <div>
                <b>{pairDone > 0 ? `跑完了 · ${pairProgress} 份朋友间关系档案` : '跑完了，但一份报告都没有'}</b>
                <span>{issues || (pairDone > 0 ? '在右栏选中一个人、再点他的连线就能看到' : maskText('看看 ~/Desktop/Murmur/agent_reports/_errors.txt 里的原因'))}</span>
              </div>
            </div>
            <p className="gx-note gx-note--faint">报告在 <code>{maskText(`${status.reports_root || '~/Desktop/Murmur/agent_reports'}/pairs/`)}</code></p>
            <div className="gx-batch__keys">
              <Button size="sm" variant="primary" onClick={onReset}>再跑一次</Button>
              <Button size="sm" onClick={onClose}>关闭</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
