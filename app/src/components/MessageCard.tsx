interface Props {
  from?: string;
  date?: string;
  text: string;
  accent?: string;
}

export function MessageCard({ from = '', date = '', text, accent = 'var(--et-orange)' }: Props) {
  return (
    <div style={{
      position: 'relative', background: 'var(--et-paper)',
      border: '0.5px solid var(--et-line-2)', borderRadius: 10,
      padding: '14px 16px 14px 22px', display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ position: 'absolute', left: 0, top: 14, bottom: 14, width: 3, background: accent, borderRadius: '0 2px 2px 0' }}/>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="et-meta" style={{ fontWeight: 600, color: 'var(--et-ink)' }}>{from}</div>
        <div className="et-meta" style={{ fontFamily: 'var(--et-mono)', fontSize: 11 }}>{date}</div>
      </div>
      <div className="et-serif" style={{ fontSize: 15, lineHeight: 1.55, color: 'var(--et-ink)' }}>「{text}」</div>
    </div>
  );
}
