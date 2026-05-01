// EchoTrace — Homepage 朋友圈年代记 (light + dark variants share this)
// Globals: HomePage

function HomeChromeBar({ dark=false }) {
  return (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'space-between',
      padding:'14px 28px', borderBottom:`0.5px solid var(--et-line)`,
      background:'transparent',
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        {/* logo mark */}
        <svg width="22" height="22" viewBox="0 0 22 22">
          <circle cx="11" cy="11" r="9.5" fill="none" stroke="var(--et-orange)" strokeWidth="1.2"/>
          <circle cx="11" cy="11" r="5.5" fill="none" stroke="var(--et-orange)" strokeWidth="1.2"/>
          <circle cx="11" cy="11" r="1.6" fill="var(--et-orange)"/>
        </svg>
        <div className="et-serif" style={{ fontSize:17, fontWeight:600, color:'var(--et-ink)', letterSpacing:'0.04em' }}>EchoTrace</div>
        <div style={{ width:1, height:14, background:'var(--et-line-2)', margin:'0 4px' }}/>
        <div className="et-meta" style={{ color:'var(--et-mute)' }}>2025 · 年代记</div>
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        <button style={{ all:'unset', cursor:'pointer', display:'flex', alignItems:'center', gap:6, color:'var(--et-mute)', fontSize:12, fontWeight:500 }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M2 7h10M7 2v10"/>
          </svg>
          更新数据
        </button>
        {window.TaskCenterBell && <TaskCenterBell count={2}/>}
        <button style={{ all:'unset', cursor:'pointer', width:30, height:30, borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--et-mute)' }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="8" cy="8" r="2.2"/>
            <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

function HeroFrame({ dark=false }) {
  const top5 = window.ET_FRIENDS.slice(0, 5);
  return (
    <div style={{
      position:'relative',
      margin:'24px 28px 0',
      padding:'40px 44px 36px',
      background: 'var(--et-paper)',
      border:`0.5px solid var(--et-line-2)`,
      borderRadius: 'var(--et-r-lg)',
      boxShadow:'var(--et-shadow-2)',
      overflow:'hidden',
    }} className="et-paper-grain">
      {/* journal frame: double border inside */}
      <div style={{ position:'absolute', inset:14, border:`0.5px solid var(--et-line)`, borderRadius:14, pointerEvents:'none' }}/>

      {/* corner postmark */}
      <div style={{ position:'absolute', top:24, right:30, transform:'rotate(8deg)', opacity:0.85 }}>
        <Postmark size={86}/>
      </div>

      {/* eyebrow ribbon */}
      <div style={{ display:'flex', alignItems:'center', gap:14 }}>
        <Ribbon color="var(--et-orange)" tone="solid">2025 · 年代记</Ribbon>
        <div className="et-meta" style={{ color:'var(--et-mute)' }}>EchoTrace · Vol. 02</div>
      </div>

      {/* big copy */}
      <div className="et-serif" style={{
        marginTop:24, fontSize:46, lineHeight:1.22, fontWeight:500,
        color:'var(--et-ink)', maxWidth:760, letterSpacing:'0.005em',
      }}>
        这些年，时间带你遇见了 <span style={{ color:'var(--et-orange)', fontWeight:600 }}>234</span> 个人，<br/>
        其中 <span style={{ color:'var(--et-orange)', fontWeight:600 }}>12</span> 位朋友，陪你走过了 <span style={{ color:'var(--et-orange)', fontWeight:600 }}>1,825</span> 天。
      </div>
      <div className="et-meta" style={{ marginTop:16, fontSize:13, color:'var(--et-mute)', maxWidth:560 }}>
        翻一翻今年最常聊的人，这是 EchoTrace 写给你的一封小信。
      </div>

      {/* top 5 lineup */}
      <div style={{
        marginTop:32, display:'grid',
        gridTemplateColumns:'repeat(5, minmax(0, 1fr))', gap:14,
        position:'relative',
      }}>
        {top5.map((f, i) => (
          <div key={f.id} style={{
            position:'relative', padding:'16px 14px 14px',
            background: i===0 ? 'var(--et-orange-soft)' : 'transparent',
            border:`0.5px solid ${i===0 ? 'rgba(224,83,46,0.25)':'var(--et-line)'}`,
            borderRadius:'var(--et-r)',
            display:'flex', flexDirection:'column', alignItems:'center', gap:8, textAlign:'center',
          }}>
            <div style={{ position:'absolute', top:-9, left:'50%', transform:'translateX(-50%)',
              background:'var(--et-paper)', border:`0.5px solid var(--et-line-2)`, borderRadius:999,
              padding:'2px 10px', fontFamily:'var(--et-serif)', fontSize:11, fontWeight:600, color: i===0?'var(--et-orange)':'var(--et-ink)' }}>
              No.{i+1}
            </div>
            <Avatar friend={f} size={i===0 ? 64 : 52} ring={i===0} />
            <div className="et-serif" style={{ fontSize:15, fontWeight:600, color:'var(--et-ink)', marginTop:2 }}>{f.name}</div>
            <div className="et-num" style={{ fontSize:18, fontWeight:600, color: i===0?'var(--et-orange)':'var(--et-ink)' }}>
              {f.count.toLocaleString()}<span style={{ fontSize:10, fontWeight:500, color:'var(--et-mute)', marginLeft:3, fontFamily:'var(--et-sans)' }}>条</span>
            </div>
            <div className="et-meta" style={{ color:'var(--et-mute)' }}>{f.last}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Timeline() {
  const data = window.ET_HEAT;
  const max = Math.max(...data);
  return (
    <div style={{
      margin:'24px 28px 0', padding:'22px 26px 18px',
      background:'var(--et-paper)', border:`0.5px solid var(--et-line-2)`,
      borderRadius:'var(--et-r)',
    }}>
      <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:14 }}>
        <div>
          <div className="et-eyebrow">时光线 · 一年里你和谁说话最多</div>
          <div className="et-serif" style={{ fontSize:18, fontWeight:500, color:'var(--et-ink)', marginTop:6 }}>八月最响，二月最静。</div>
        </div>
        <div style={{ display:'flex', gap:12, alignItems:'center' }}>
          <span className="et-meta">高峰 · 8月 <span className="et-num" style={{ color:'var(--et-orange)', fontWeight:600 }}>14,203</span> 条</span>
          <span className="et-meta">沉默 · 2月 <span className="et-num" style={{ fontWeight:600 }}>3,118</span> 条</span>
        </div>
      </div>
      <Sparkline w={870} h={88} />
    </div>
  );
}

function FilterBar({ tab, setTab, search }) {
  const tabs = [
    { id:'private', label:'私聊朋友', count:128 },
    { id:'group',   label:'群聊',     count:34  },
    { id:'time',    label:'按时间',   count:null },
  ];
  return (
    <div style={{
      margin:'28px 28px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:16,
      paddingBottom:14, borderBottom:`0.5px solid var(--et-line-2)`,
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={()=>setTab(t.id)} style={{
            all:'unset', cursor:'pointer',
            padding:'8px 14px', borderRadius:'999px',
            fontFamily:'var(--et-sans)', fontSize:13, fontWeight: t.id===tab ? 600 : 500,
            color: t.id===tab ? 'var(--et-paper)' : 'var(--et-ink)',
            background: t.id===tab ? 'var(--et-ink)' : 'transparent',
            display:'flex', alignItems:'center', gap:6,
          }}>
            <span>{t.label}</span>
            {t.count!=null && <span style={{ fontSize:11, opacity:0.7, fontVariantNumeric:'tabular-nums' }}>{t.count}</span>}
          </button>
        ))}
        <div style={{ width:1, height:18, background:'var(--et-line-2)', margin:'0 6px' }}/>
        <span className="et-meta" style={{ color:'var(--et-mute)' }}>排序 · 总消息数 ↓</span>
      </div>
      <div style={{
        display:'flex', alignItems:'center', gap:8,
        padding:'7px 12px', border:`0.5px solid var(--et-line-2)`, borderRadius:999,
        background:'var(--et-paper)', minWidth:220,
      }}>
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="var(--et-mute)" strokeWidth="1.4">
          <circle cx="5.5" cy="5.5" r="4"/><path d="M8.5 8.5l3 3" strokeLinecap="round"/>
        </svg>
        <input placeholder="搜索朋友" defaultValue={search||''} style={{
          all:'unset', flex:1, fontFamily:'var(--et-sans)', fontSize:13, color:'var(--et-ink)',
        }}/>
      </div>
    </div>
  );
}

function HomePage({ dark=false, onOpenFriend }) {
  const [tab, setTab] = React.useState('private');
  return (
    <div className={`et-root ${dark?'et-dark':''}`} style={{ background:'var(--et-bg)', minHeight:'100%' }}>
      <HomeChromeBar dark={dark}/>
      <HeroFrame dark={dark}/>
      <Timeline />
      <FilterBar tab={tab} setTab={setTab} />
      <div style={{
        margin:'0 28px 36px', display:'grid',
        gridTemplateColumns:'repeat(4, minmax(0,1fr))', gap:14,
      }}>
        {window.ET_FRIENDS.map((f, i) => (
          <FriendCard key={f.id} friend={f} rank={i+1} onClick={()=>onOpenFriend && onOpenFriend(f)} />
        ))}
      </div>
      {/* footer line */}
      <div style={{ margin:'0 28px 24px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div className="et-meta" style={{ color:'var(--et-mute)' }}>
          全部数据均在你的电脑上 · 不会上传到任何云端
        </div>
        <div className="et-meta" style={{ fontFamily:'var(--et-mono)', color:'var(--et-faint)' }}>v2.0 · 2025·12·31</div>
      </div>
    </div>
  );
}

Object.assign(window, { HomePage });
