/* 双人年代记 (#/yearbook/<id>) — you and one friend, year by year.
 *
 *   52 抬头   who, how long, six readouts
 *   53 逐年   one ledger row per year (click → that year below)
 *   54 分享卡  the latest year as a saveable card (./extras/YearbookCover)
 *   55 逐年档案 per-year metrics, week × hour grid, words, quotes
 *
 * Styles: ./Yearbook.css (prefix yb-). */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { errorCode, getYearbook } from '../data/api';
import type { Yearbook, YearData } from '../data/api';
import { lookupError } from '../data/errorCatalog';
import { displayName, maskedWxid, maskText } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { PageHeader } from '../shell/PageHeader';
import { useActivePlatform } from '../utils/activeProfile';
import { Button, EmptyState, ErrorState, Module, Skeleton, cx } from '../ui';
import { IconCalendar } from '../ui/icons';
import { YearbookCover } from './extras/YearbookCover';
import './Yearbook.css';

interface Props {
  friendId: string;
  onBack: () => void;
}

function n0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
/** 「朋友 PB」→ PB, 「群 3」→ 3, otherwise the first character. */
function monogram(name: string): string {
  const m = /^(?:朋友|群)\s*(\S{1,3})$/.exec(name);
  if (m) return m[1];
  return Array.from(name.replace(/\s+/g, ''))[0] ?? '·';
}

export function YearbookPage({ friendId, onBack }: Props) {
  void usePrivacy();
  const platform = useActivePlatform();
  const [data, setData] = useState<Yearbook | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData(null);
    getYearbook(friendId)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e); });
    return () => { cancelled = true; };
  }, [friendId, nonce]);

  const back = { label: '朋友页', onClick: onBack };

  if (error) {
    const code = errorCode(error);
    const entry = lookupError(code);
    const raw = error instanceof Error ? error.message : String(error);
    return (
      <div className="yb-page">
        <PageHeader back={back} title="双人年代记" />
        <ErrorState
          layout="page"
          code={code ?? undefined}
          title={entry?.title ?? '年代记没能编出来'}
          reason={entry?.reason ?? '按年份整理你们的聊天时，本地服务返回了错误。'}
          fixes={entry ? [entry.fix] : ['点「重试」再编一次', '还不行就到「设置」里复制诊断信息反馈给我们']}
          onRetry={() => setNonce(n => n + 1)}
          details={raw ? <pre>{maskText(raw)}</pre> : undefined}
        />
      </div>
    );
  }
  if (!data) return <YearbookSkeleton back={back} />;

  const friendName = displayName(data.wxid, data.name);
  const yearsAsc = Array.isArray(data.years) ? data.years : [];
  if (yearsAsc.length === 0) {
    return (
      <div className="yb-page">
        <PageHeader back={back} title={`双人年代记 · 你 ↔ ${friendName}`} />
        <EmptyState
          className="yb-empty"
          layout="page"
          icon={<IconCalendar size={24} />}
          label="NO DATA · YEARS 00"
          title="消息还不够编成年代记"
          description={`你和 ${friendName} 目前有 ${fmt(n0(data.total_msgs))} 条消息。等你们聊满一段日子，这里会按年份排出你们的故事。`}
          actions={<Button onClick={onBack}>回到朋友页</Button>}
        />
      </div>
    );
  }

  const latest = yearsAsc[yearsAsc.length - 1];
  const maxMsgs = Math.max(1, ...yearsAsc.map(y => n0(y.msg_count)));
  const scrollTo = (year: number) => {
    document.getElementById(`yb-y${year}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="yb-page">
      <PageHeader
        back={back}
        title={`双人年代记 · 你 ↔ ${friendName}`}
        subtitle={<span className="ui-num">{maskedWxid(data.wxid)}</span>}
      />
      <div className="yb-rack ui-rack">
        <HeadModule data={data} friendName={friendName} showMoments={platform !== 'qq'} />
        <LedgerModule years={yearsAsc} maxMsgs={maxMsgs} onPick={scrollTo} />
        <Module id="54" title="分享卡" en={`SHARE · ${latest.year}`} className="yb-m54" bodyClassName="yb-m54__body">
          <div className="yb-m54__stick">
            <YearbookCover
              friendId={data.wxid}
              friendName={data.name}
              year={latest}
              firstWordsDate={data.first_date}
            />
          </div>
        </Module>
        <Module id="55" title="逐年档案" en="YEAR BY YEAR · 新 → 旧" right={`${pad2(yearsAsc.length)} YEARS`} className="yb-m55">
          {[...yearsAsc].reverse().map((y, i) => (
            <YearBlock key={y.year} y={y} ordinal={yearsAsc.length - i} maxMsgs={maxMsgs} friendName={friendName} />
          ))}
        </Module>
      </div>
    </div>
  );
}

// ———————————————————————— loading ————————————————————————

function YearbookSkeleton({ back }: { back: { label: string; onClick: () => void } }) {
  return (
    <div className="yb-page" aria-busy="true">
      <PageHeader back={back} title="双人年代记" />
      <div className="yb-rack ui-rack">
        <Module as="div" className="yb-m52" aria-label="正在编织年代记">
          <div className="yb-id" role="status">
            <div className="yb-id__code is-wait" aria-hidden="true">··</div>
            <div className="yb-id__text">
              <div className="ui-label">CHRONICLE<b>正在按年份整理你们的聊天</b></div>
              <Skeleton width={260} height={20} />
              <Skeleton width={180} height={10} />
            </div>
          </div>
          <div className="yb-ros" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="yb-ro"><Skeleton width={64} height={10} /><Skeleton width="60%" height={28} /><Skeleton width="44%" height={9} /></div>
            ))}
          </div>
        </Module>
        <Module id="53" title="逐年" en="LEDGER" className="yb-m53" aria-hidden="true">
          <div className="yb-skel">
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} width={`${92 - ((i * 17) % 40)}%`} height={12} />)}
          </div>
        </Module>
        <Module id="54" title="分享卡" en="SHARE" className="yb-m54" aria-hidden="true">
          <div className="yb-skel yb-skel--card"><Skeleton width="100%" height={420} /></div>
        </Module>
        <Module id="55" title="逐年档案" en="YEAR BY YEAR" className="yb-m55" aria-hidden="true">
          <div className="yb-skel">
            {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} width={`${88 - ((i * 23) % 36)}%`} height={12} />)}
          </div>
        </Module>
      </div>
    </div>
  );
}

// ———————————————————————— 52 抬头 ————————————————————————

function Readout({ en, zh, children, sub }: { en: string; zh: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="yb-ro">
      <div className="ui-label yb-ro__k">{en}<b>{zh}</b></div>
      <div className="ui-big yb-ro__v">{children}</div>
      <div className="yb-ro__s">{sub ?? ' '}</div>
    </div>
  );
}

function HeadModule({ data, friendName, showMoments }: { data: Yearbook; friendName: string; showMoments: boolean }) {
  const years = data.years;
  const code = monogram(friendName);
  const activeDays = years.reduce((s, y) => s + n0(y.active_days), 0);
  const calls = years.reduce((s, y) => s + n0(y.calls), 0);
  const first = years[0]?.year;
  const last = years[years.length - 1]?.year;
  const back = n0(data.moments_back_total);
  const out = n0(data.moments_out_total);
  return (
    <Module as="div" className="yb-m52" aria-label={`你和 ${friendName} 的双人年代记`}>
      <div className="yb-id">
        <div className={cx('yb-id__code', Array.from(code).length > 2 && 'is-long')} aria-hidden="true">{code}</div>
        <div className="yb-id__text">
          <div className="ui-label">CHRONICLE<b>双人年代记</b></div>
          <h2 className="yb-id__title">你和 {friendName} 一起走过 <span className="ui-num">{n0(data.active_years) || years.length}</span> 年</h2>
          <div className="yb-id__meta">
            {data.first_date && data.last_date && <span>{data.first_date} → {data.last_date}</span>}
            <span>{maskedWxid(data.wxid)}</span>
          </div>
        </div>
      </div>
      <div className="yb-ros">
        <Readout en="SPAN" zh="跨度" sub={first != null && last != null ? `${first} – ${last}` : undefined}>
          {fmt(n0(data.span_days))}<small>D</small>
        </Readout>
        <Readout en="MSG" zh="总消息" sub="含图文 / 语音">{fmt(n0(data.total_msgs))}</Readout>
        <Readout en="YEARS" zh="有聊天的年份" sub={`共 ${years.length} 段`}>
          {n0(data.active_years) || years.length}<small>Y</small>
        </Readout>
        <Readout en="ACTIVE" zh="有交流的天数" sub={data.span_days ? `占跨度 ${Math.round((activeDays / Math.max(1, n0(data.span_days))) * 100)}%` : undefined}>
          {fmt(activeDays)}<small>D</small>
        </Readout>
        <Readout en="CALLS" zh="通话" sub={calls ? '语音 + 视频' : '没有通话记录'}>
          {fmt(calls)}<small>次</small>
        </Readout>
        {showMoments ? (
          <Readout en="MOMENTS" zh="朋友圈往来" sub={`ta 赞 ${fmt(back)} · 你赞 ${fmt(out)}`}>{fmt(back + out)}</Readout>
        ) : (
          <Readout en="FIRST" zh="第一次说话" sub={data.first_date ? '有记录的第一天' : undefined}>
            <span className="yb-ro__date">{data.first_date ? data.first_date.slice(0, 7) : '—'}</span>
          </Readout>
        )}
      </div>
    </Module>
  );
}

// ———————————————————————— 53 逐年 ————————————————————————

const VU = 24;

function LedgerModule({ years, maxMsgs, onPick }: { years: YearData[]; maxMsgs: number; onPick: (y: number) => void }) {
  const peak = years.reduce((p, y) => (n0(y.msg_count) > n0(p.msg_count) ? y : p), years[0]);
  return (
    <Module id="53" title="逐年" en="LEDGER" right={`PEAK ${peak.year} · ${fmt(n0(peak.msg_count))}`} className="yb-m53" scroll>
      <table className="yb-led">
        <thead>
          <tr>
            <th scope="col">YEAR</th>
            <th scope="col" className="yb-led__vu">MSG</th>
            <th scope="col" className="r">条</th>
            <th scope="col" className="r">天</th>
            <th scope="col" className="r">你说</th>
            <th scope="col" className="r yb-hide-sm">最热月</th>
            <th scope="col" className="r yb-hide-sm">深夜</th>
          </tr>
        </thead>
        <tbody>
          {[...years].reverse().map(y => {
            const c = n0(y.msg_count);
            const on = Math.max(c > 0 ? 1 : 0, Math.round((c / maxMsgs) * VU));
            const isPeak = y.year === peak.year;
            return (
              <tr key={y.year} className={cx(isPeak && 'is-peak')}>
                <th scope="row">
                  <button type="button" className="yb-led__y" onClick={() => onPick(y.year)} title={`看 ${y.year} 年`}>{y.year}</button>
                </th>
                <td className="yb-led__vu">
                  <span className="yb-seg" aria-hidden="true">
                    {Array.from({ length: VU }, (_, s) => <i key={s} className={cx(s < on && (isPeak ? 'pk' : 'on'))} />)}
                  </span>
                </td>
                <td className="r yb-led__n">{fmt(c)}</td>
                <td className="r">{fmt(n0(y.active_days))}</td>
                <td className="r">{n0(y.self_pct)}<small>%</small></td>
                <td className="r yb-hide-sm">{y.busiest_month ? `${pad2(y.busiest_month)} 月` : '—'}</td>
                <td className="r yb-hide-sm">{n0(y.late_night_pct)}<small>%</small></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Module>
  );
}

// ———————————————————————— 55 per year ————————————————————————

type Quote = { date: string; from: string; from_id?: string; text: string };

const QUOTE_KINDS: { key: keyof YearData; en: string; zh: string }[] = [
  { key: 'vulnerability_quotes', en: 'OPEN', zh: '脆弱表达' },
  { key: 'offline_quotes', en: 'MEET', zh: '线下证据' },
  { key: 'lifecycle_quotes', en: 'LIFE', zh: '人生节点' },
  { key: 'apology_quotes', en: 'MEND', zh: '冲突修复' },
  { key: 'care_quotes', en: 'CARE', zh: '互相关心' },
];

function YearBlock({ y, ordinal, maxMsgs, friendName }: { y: YearData; ordinal: number; maxMsgs: number; friendName: string }) {
  void usePrivacy();
  const msgs = n0(y.msg_count);
  const quotes: { en: string; zh: string; q: Quote }[] = [];
  for (const k of QUOTE_KINDS) {
    const list = y[k.key];
    if (Array.isArray(list) && list[0] && typeof list[0] === 'object') quotes.push({ en: k.en, zh: k.zh, q: list[0] as Quote });
  }
  const heat = Array.isArray(y.heatmap_24x7) && y.heatmap_24x7.length === 168 ? y.heatmap_24x7 : null;
  const words = Array.isArray(y.top_words) ? y.top_words.slice(0, 8) : [];
  const sig = y.signature && typeof y.signature === 'object' && y.signature.text ? y.signature : null;
  const isPeak = msgs === maxMsgs;
  const calls = n0(y.calls);

  return (
    <section className={cx('yb-yr', isPeak && 'is-peak')} id={`yb-y${y.year}`} aria-label={`${y.year} 年`}>
      <header className="yb-yr__strip">
        <span className="yb-yr__year">{y.year}</span>
        <span className="yb-yr__ord">第 {ordinal} 年</span>
        {isPeak && <span className="yb-tag is-signal">PEAK</span>}
        <span className="yb-yr__r">
          <span><b>{fmt(msgs)}</b> MSG</span>
          <span><b>{fmt(n0(y.active_days))}</b> D</span>
          {calls > 0 && <span className="yb-hide-sm"><b>{fmt(calls)}</b> 通话</span>}
        </span>
      </header>
      <div className="yb-yr__level" aria-hidden="true"><i style={{ width: `${Math.max(1, (msgs / maxMsgs) * 100)}%` }} /></div>

      <div className="yb-cells">
        <Cell en="SHARE" zh="主导比" value={<>你 {n0(y.self_pct)}<small>%</small></>} sub={`${friendName} ${100 - n0(y.self_pct)}%`} />
        <Cell en="PEAK" zh="最热月" value={y.busiest_month ? <>{pad2(y.busiest_month)}<small>月</small></> : '—'} sub={`${fmt(n0(y.busiest_month_msgs))} 条`} />
        <Cell en="SILENCE" zh="最长沉默" value={n0(y.longest_silence_days) > 0 ? <>{y.longest_silence_days}<small>天</small></> : '—'}
          sub={y.silence_from ? `${y.silence_from} 起` : ''} />
        <Cell en="NIGHT" zh="深夜聊天" value={<>{n0(y.late_night_pct)}<small>%</small></>} sub={`${fmt(n0(y.late_night_msgs))} 条 23-4 点`} />
        <ExtraCells y={y} friendName={friendName} />
      </div>

      {(heat || words.length > 0) && (
        <div className={cx('yb-yr__pair', !(heat && words.length) && 'is-single')}>
          {heat && <HeatGrid data={heat} />}
          {words.length > 0 && <Words words={words} />}
        </div>
      )}

      {(sig || quotes.length > 0) && (
        <div className="yb-yr__quotes">
          {sig && <Signature sig={sig} />}
          {quotes.length > 0 && (
            <ol className="yb-q">
              {quotes.map((b, i) => (
                <li key={i} className="yb-q__row">
                  <span className="yb-q__k"><span className="yb-tag">{b.en}</span><span className="yb-q__zh">{b.zh}</span></span>
                  <span className="yb-q__t">{maskText(b.q.text)}</span>
                  <span className="yb-q__m">{displayName(b.q.from_id, b.q.from)} · {b.q.date}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

function Cell({ en, zh, value, sub }: { en: string; zh: string; value: ReactNode; sub?: string }) {
  return (
    <div className="yb-cell">
      <div className="ui-label yb-cell__k">{en}<b>{zh}</b></div>
      <div className="yb-cell__v">{value}</div>
      <div className="yb-cell__s">{sub || ' '}</div>
    </div>
  );
}

function ExtraCells({ y, friendName }: { y: YearData; friendName: string }) {
  const hasStreak = (y.longest_streak_days || 0) > 0;
  const hasInitiative = (y.session_starts_self || 0) + (y.session_starts_other || 0) > 0;
  const hasMidnightSplit = (y.late_night_msgs || 0) >= 6 && y.midnight_friend_pct != null;
  const hasDecay = (y.first_half_msgs || 0) + (y.second_half_msgs || 0) > 0;
  // reply latency is folded into the AI report's data fingerprint section;
  // it is not shown here so the grid stays at eight cells.
  if (!hasStreak && !hasInitiative && !hasMidnightSplit && !hasDecay) return null;

  const streakSub = hasStreak && y.streak_start && y.streak_end ? `${y.streak_start} → ${y.streak_end}` : '';
  const initiativeSub = hasInitiative
    ? `你 ${y.session_starts_self ?? 0} 次 · ${friendName} ${y.session_starts_other ?? 0} 次` : '';

  let decayValue: ReactNode = '—';
  let decaySub = '';
  if (hasDecay) {
    const f = y.first_half_msgs || 0;
    const s = y.second_half_msgs || 0;
    const total = f + s;
    decayValue = s > f * 1.2 ? '↑ 增长' : f > s * 1.2 ? '↓ 减弱' : '→ 平稳';
    decaySub = `前段 ${Math.round(f / total * 100)}% · 后段 ${Math.round(s / total * 100)}%`;
  }

  return (
    <>
      <Cell en="STREAK" zh="最长连聊" value={hasStreak ? <>{y.longest_streak_days}<small>天</small></> : '—'} sub={streakSub} />
      <Cell en="STARTS" zh="谁先开聊" value={hasInitiative ? <>你 {y.initiative_self_pct ?? 0}<small>%</small></> : '—'} sub={initiativeSub} />
      <Cell en="NIGHT SIDE" zh="深夜偏向"
        value={hasMidnightSplit ? <><span className="yb-cell__who">{friendName.slice(0, 8)}</span> {y.midnight_friend_pct}<small>%</small></> : '—'}
        sub={hasMidnightSplit ? '深夜里 ta 说话的占比' : ''} />
      <Cell en="TREND" zh="全年趋势" value={decayValue} sub={decaySub} />
    </>
  );
}

const DAYS = ['一', '二', '三', '四', '五', '六', '日'];

function HeatGrid({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  const level = (v: number) => (v <= 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 3.999)));
  const peakIdx = data.indexOf(Math.max(...data));
  return (
    <div className="yb-heat">
      <div className="yb-sub"><span className="ui-label">WEEK × HOUR<b>168 格热力图</b></span><span className="yb-sub__r">00 → 24 时</span></div>
      <div className="yb-heat__grid" role="img" aria-label="一周七天 × 二十四小时的消息分布">
        {DAYS.map((d, w) => (
          <div key={w} className="yb-heat__row">
            <span className="yb-heat__d">{d}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const v = data[w * 24 + h] || 0;
              return (
                <span key={h} className={cx('yb-heat__c', `l${level(v)}`, w * 24 + h === peakIdx && v > 0 && 'is-peak')}
                  title={`周${d} ${h}:00 · ${v} 条`} />
              );
            })}
          </div>
        ))}
        <div className="yb-heat__row yb-heat__ticks" aria-hidden="true">
          <span />
          {Array.from({ length: 24 }, (_, h) => <span key={h}>{h % 6 === 0 ? pad2(h) : ''}</span>)}
        </div>
      </div>
    </div>
  );
}

function Words({ words }: { words: Array<{ word: string; count: number }> }) {
  const max = Math.max(1, n0(words[0]?.count));
  return (
    <div className="yb-words">
      <div className="yb-sub"><span className="ui-label">WORDS<b>这一年常聊</b></span><span className="yb-sub__r">TOP {pad2(words.length)} · 词频</span></div>
      <ol className="yb-w">
        {words.map((w, i) => (
          <li key={`${w.word}-${i}`} className={cx('yb-w__row', i === 0 && 'is-first')} title={`出现 ${fmt(n0(w.count))} 次`}>
            <span className="yb-w__no">{pad2(i + 1)}</span>
            <span className="yb-w__t">{maskText(w.word)}</span>
            <span className="yb-w__bar" aria-hidden="true"><i style={{ width: `${(n0(w.count) / max) * 100}%` }} /></span>
            <span className="yb-w__n">{fmt(n0(w.count))}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Signature({ sig }: {
  sig: { date: string; from: string; from_id?: string; text: string; reason?: string; terms?: string[] };
}) {
  return (
    <figure className="yb-sig">
      <div className="yb-sub"><span className="ui-label">EXCERPT<b>算法选中的片段</b></span><span className="yb-sub__r">可复核，不当作全部</span></div>
      <blockquote className="yb-sig__t">{maskText(sig.text)}</blockquote>
      <figcaption className="yb-sig__m">
        <span className="yb-sig__who">{displayName(sig.from_id, sig.from)}</span>
        <span>{sig.date}</span>
        {sig.reason && <span>依据 · <b>{maskText(sig.reason)}</b></span>}
        {!!sig.terms?.length && (
          <span className="yb-sig__terms">
            {sig.terms.slice(0, 3).map((t, i) => <span key={`${t}-${i}`} className="yb-tag">{maskText(t)}</span>)}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
