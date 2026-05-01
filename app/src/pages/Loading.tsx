import { useEffect, useState } from 'react';
import { ScanFrame } from '../components/ScanFrame';
import { Stamp } from '../components/Stamp';

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

  return (
    <div className="et-root" style={{
      background: 'var(--et-bg)', minHeight: '100vh',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '48px 24px', position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 32, right: 48, transform: 'rotate(8deg)', opacity: 0.8 }}>
        <Stamp size={64} label="MURMUR · 2026" />
      </div>
      <div style={{ position: 'absolute', top: 32, left: 48, display: 'flex', alignItems: 'center', gap: 8 }}>
        <svg width="20" height="20" viewBox="0 0 22 22">
          <circle cx="11" cy="11" r="9.5" fill="none" stroke="var(--et-orange)" strokeWidth="1.2" />
          <circle cx="11" cy="11" r="5.5" fill="none" stroke="var(--et-orange)" strokeWidth="1.2" />
          <circle cx="11" cy="11" r="1.6" fill="var(--et-orange)" />
        </svg>
        <span className="et-serif" style={{ fontSize: 15, fontWeight: 600, color: 'var(--et-ink)' }}>Murmur 微语</span>
      </div>
      <ScanFrame size={240} />
      <div className="et-h1" style={{ marginTop: 36, color: 'var(--et-ink)', textAlign: 'center', maxWidth: 520 }}>
        {lines[li]}
      </div>
      <div style={{ marginTop: 28, width: 420, maxWidth: '80%' }}>
        <div style={{ height: 6, background: 'rgba(26,43,74,0.08)', borderRadius: 999, overflow: 'hidden' }}>
          <div style={{
            width: `${pct}%`, height: '100%',
            background: 'linear-gradient(90deg, var(--et-orange) 0%, var(--et-rose) 100%)',
            borderRadius: 999, transition: 'width .35s ease',
          }}/>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
          <span className="et-meta">{pct >= 95 ? '马上好' : '大约还有 12 秒'}</span>
          <span className="et-num" style={{ fontSize: 12, color: 'var(--et-mute)' }}>{Math.round(pct)}%</span>
        </div>
      </div>
      <div style={{ marginTop: 36, padding: '14px 22px',
        background: 'var(--et-paper)', border: '0.5px solid var(--et-line-2)',
        borderRadius: 'var(--et-r)', maxWidth: 480, textAlign: 'center' }}>
        <span className="et-serif" style={{ fontSize: 14, color: 'var(--et-ink-soft)', fontStyle: 'italic' }}>
          「这一切都在你的电脑上完成，不会上传任何内容到云端。」
        </span>
      </div>
      <div className="et-meta" style={{ position: 'absolute', bottom: 24, color: 'var(--et-faint)' }}>
        首次会慢一点点 · 之后再打开通常 3 秒之内
      </div>
    </div>
  );
}
