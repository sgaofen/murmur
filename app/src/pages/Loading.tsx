// First-run loading screen · direction B「仪器」: status strip, one big
// percentage readout over a segmented meter, the rotating status line.
import { useEffect, useState } from 'react';
import './Loading.css';

const SEGS = 48;

interface Props {
  onDone?: () => void;
}

export function LoadingPage({ onDone }: Props) {
  const [pct, setPct] = useState(8);
  const [li, setLi] = useState(0);
  const lines = [
    '正在为你重新整理这些年的对话…',
    '把照片、语音、转账都按时间放好…',
    '给老朋友按消息数排个顺序…',
  ];

  useEffect(() => {
    const t = setInterval(() => {
      setPct(p => {
        const next = Math.min(100, p + Math.random() * 4 + 1);
        if (next >= 100 && onDone) setTimeout(onDone, 600);
        return next;
      });
    }, 220);
    return () => clearInterval(t);
  }, [onDone]);

  useEffect(() => {
    const t = setInterval(() => setLi(i => (i + 1) % lines.length), 3200);
    return () => clearInterval(t);
  }, [lines.length]);

  const shown = Math.round(pct);
  const lit = Math.round((Math.min(100, pct) / 100) * SEGS);
  return (
    <div className="ld">
      <header className="ld-strip">
        <span className="ld-brand">MURMUR<span>微语</span></span>
        <span className="ld-crumb">BOOT /<b>载入</b></span>
        <span className="ld-strip__r"><i className="ui-led is-pulse" />LOCAL · 本机</span>
      </header>

      <div className="ld-stage">
        <div className="ld-panel" role="progressbar" aria-label="载入进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown}>
          <div className="ui-label">STATUS<b>正在载入</b></div>
          <div className="ld-read">
            <div className="ui-big ld-big">{String(shown).padStart(2, '0')}<small>%</small></div>
            <div className="ld-meta">
              <div className="ui-label">ETA<b>{pct >= 95 ? '马上好' : '大约还有 12 秒'}</b></div>
            </div>
          </div>
          <div className="ld-segs" aria-hidden="true">
            {Array.from({ length: SEGS }, (_, i) => <i key={i} className={i < lit ? 'on' : undefined} />)}
          </div>
          <div className="ld-scale" aria-hidden="true"><span>0</span><span>50</span><span>100</span></div>
          <p className="ld-line" aria-live="polite" key={li}>{lines[li]}</p>
          <div className="ld-local">
            <span className="ui-label">LOCAL</span>
            <span>这一切都在你的电脑上完成，不会上传任何内容到云端。</span>
          </div>
        </div>
      </div>

      <footer className="ld-foot">首次会慢一点点 · 之后再打开通常 3 秒之内</footer>
    </div>
  );
}
