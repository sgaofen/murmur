// EchoTrace — Mobile homepage (375x812)
// Globals: HomeMobile

function HomeMobile() {
  const top3 = window.ET_FRIENDS.slice(0,3);
  const list = window.ET_FRIENDS;
  return (
    <div className="et-root" style={{
      width:'100%', height:'100%', background:'var(--et-bg)',
      overflow:'hidden auto', display:'flex', flexDirection:'column',
    }}>
      {/* status spacer */}
      <div style={{ height:54 }}/>
      {/* nav */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'4px 20px 12px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <svg width="18" height="18" viewBox="0 0 22 22">
            <circle cx="11" cy="11" r="9.5" fill="none" stroke="var(--et-orange)" strokeWidth="1.4"/>
            <circle cx="11" cy="11" r="1.6" fill="var(--et-orange)"/>
          </svg>
          <span className="et-serif" style={{ fontSize:15, fontWeight:600 }}>EchoTrace</span>
        </div>
        <div style={{ display:'flex', gap:14, color:'var(--et-mute)' }}>
          <span style={{ fontSize:18 }}>⌕</span>
          <span style={{ fontSize:18 }}>⚙</span>
        </div>
      </div>
      {/* hero */}
      <div style={{
        margin:'0 16px', padding:'24px 22px',
        background:'var(--et-paper)', border:'0.5px solid var(--et-line-2)',
        borderRadius:18, position:'relative', overflow:'hidden',
      }} className="et-paper-grain">
        <div style={{ position:'absolute', top:14, right:14, transform:'rotate(8deg)' }}>
          <Postmark size={56}/>
        </div>
        <Ribbon color="var(--et-orange)" tone="solid">2025 · 年代记</Ribbon>
        <div className="et-serif" style={{ marginTop:14, fontSize:24, lineHeight:1.3, color:'var(--et-ink)' }}>
          这些年，时间带你<br/>遇见了 <span style={{ color:'var(--et-orange)' }}>234</span> 个人。
        </div>
        <div className="et-meta" style={{ marginTop:8 }}>翻一翻今年最常聊的人 →</div>
        {/* top 3 horizontal */}
        <div style={{ marginTop:18, display:'flex', gap:10 }}>
          {top3.map((f, i) => (
            <div key={f.id} style={{
              flex:1, padding:'12px 8px',
              background: i===0 ? 'var(--et-orange-soft)' : 'transparent',
              border:`0.5px solid ${i===0 ? 'rgba(224,83,46,0.25)':'var(--et-line)'}`,
              borderRadius:12,
              display:'flex', flexDirection:'column', alignItems:'center', gap:6,
            }}>
              <div style={{ position:'relative' }}>
                <Avatar friend={f} size={42} ring={i===0}/>
                <span style={{ position:'absolute', top:-6, right:-8, fontSize:9, fontWeight:600, color:'var(--et-orange)', background:'var(--et-paper)', border:'0.5px solid var(--et-line-2)', borderRadius:999, padding:'1px 5px' }}>#{i+1}</span>
              </div>
              <div className="et-serif" style={{ fontSize:12, fontWeight:600 }}>{f.name}</div>
              <div className="et-num" style={{ fontSize:13, fontWeight:600, color: i===0?'var(--et-orange)':'var(--et-ink)' }}>{f.count.toLocaleString()}</div>
            </div>
          ))}
        </div>
      </div>
      {/* timeline mini */}
      <div style={{ margin:'18px 16px 0', padding:'14px 16px', background:'var(--et-paper)', border:'0.5px solid var(--et-line-2)', borderRadius:14 }}>
        <div className="et-eyebrow" style={{ fontSize:9 }}>时光线</div>
        <Sparkline w={300} h={56}/>
      </div>
      {/* tabs */}
      <div style={{ margin:'18px 16px 8px', display:'flex', gap:6 }}>
        {[['private','私聊'], ['group','群聊'], ['time','按时间']].map(([id,label], i) => (
          <button key={id} style={{
            all:'unset', padding:'6px 12px', borderRadius:999, fontSize:12, fontWeight: i===0?600:500,
            background: i===0?'var(--et-ink)':'transparent', color: i===0?'var(--et-paper)':'var(--et-ink)',
            border: i===0?'none':'0.5px solid var(--et-line-2)',
          }}>{label}</button>
        ))}
      </div>
      {/* list */}
      <div style={{ margin:'4px 16px 24px', display:'flex', flexDirection:'column', gap:8 }}>
        {list.slice(0,8).map((f, i) => (
          <div key={f.id} style={{
            display:'flex', alignItems:'center', gap:12,
            padding:'12px 14px', background:'var(--et-paper)',
            border:'0.5px solid var(--et-line-2)', borderRadius:14,
          }}>
            <span className="et-num" style={{ fontSize:11, color:'var(--et-mute)', width:18, textAlign:'center' }}>{String(i+1).padStart(2,'0')}</span>
            <Avatar friend={f} size={40}/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ display:'flex', alignItems:'baseline', gap:6 }}>
                <span className="et-serif" style={{ fontSize:14, fontWeight:600 }}>{f.name}</span>
                <span className={`et-chip ${f.tagKind||''}`} style={{ fontSize:10, padding:'1px 6px' }}>{f.tag}</span>
              </div>
              <div className="et-meta" style={{ fontSize:11, marginTop:2 }}>{f.bond}</div>
            </div>
            <div style={{ textAlign:'right', flexShrink:0 }}>
              <div className="et-num" style={{ fontSize:14, fontWeight:600, color:'var(--et-ink)' }}>{f.count.toLocaleString()}</div>
              <div className="et-meta" style={{ fontSize:10 }}>{f.last}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
Object.assign(window, { HomeMobile });
