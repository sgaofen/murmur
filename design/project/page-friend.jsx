// EchoTrace — Single friend page (和 X 的故事)
// Globals: FriendPage

function FriendChromeBar({ onBack, friend }) {
  return (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'space-between',
      padding:'14px 28px', borderBottom:'0.5px solid var(--et-line)',
    }}>
      <button onClick={onBack} style={{
        all:'unset', cursor:'pointer', display:'flex', alignItems:'center', gap:6,
        color:'var(--et-mute)', fontSize:13, fontWeight:500,
      }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M8 2L3 7l5 5" strokeLinecap="round"/>
        </svg>
        回到年代记
      </button>
      <div className="et-serif" style={{ fontSize:14, color:'var(--et-mute)' }}>和 {friend.name} 的故事</div>
      <div style={{ display:'flex', gap:8 }}>
        <button style={{ all:'unset', cursor:'pointer', padding:'5px 10px', borderRadius:6, fontSize:12, color:'var(--et-mute)' }}>⋯ 更多</button>
      </div>
    </div>
  );
}

function PersonCard({ friend }) {
  return (
    <div style={{
      position:'relative', padding:'28px 30px', display:'grid',
      gridTemplateColumns:'auto 1fr', gap:24, alignItems:'center',
      background:'var(--et-paper)', border:'0.5px solid var(--et-line-2)',
      borderRadius:'var(--et-r-lg)', boxShadow:'var(--et-shadow-2)',
      overflow:'hidden',
    }} className="et-paper-grain">
      <div style={{ position:'absolute', top:18, right:22, transform:'rotate(-6deg)', opacity:0.85 }}>
        <Stamp size={62}/>
      </div>
      <div style={{ position:'relative' }}>
        <Avatar friend={friend} size={108} />
        <span className={`et-chip ${friend.tagKind||''}`} style={{ position:'absolute', bottom:-8, left:'50%', transform:'translateX(-50%)' }}>{friend.tag}</span>
      </div>
      <div>
        <div className="et-eyebrow">人物档案 · No.01</div>
        <div className="et-h1" style={{ marginTop:8, color:'var(--et-ink)' }}>{friend.name}</div>
        <div className="et-meta" style={{ marginTop:6, color:'var(--et-mute)' }}>{friend.knew} · 最近活跃 {friend.last}</div>
        <div className="et-serif" style={{
          marginTop:18, fontSize:17, lineHeight:1.65, color:'var(--et-ink-soft)',
          paddingLeft:14, borderLeft:'2.5px solid var(--et-orange)',
          maxWidth:540, fontStyle:'italic',
        }}>
          「你深夜聊天最多的朋友。认识 4 年，{friend.count.toLocaleString()} 条消息，几乎是你和别人平均聊天量的 6 倍。」
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value, sub, big=false }) {
  return (
    <div style={{
      flex:1, padding:'16px 18px', background:'var(--et-paper)',
      border:'0.5px solid var(--et-line-2)', borderRadius:'var(--et-r)',
      display:'flex', flexDirection:'column', gap:4, minWidth:0,
    }}>
      <div className="et-eyebrow" style={{ fontSize:10 }}>{label}</div>
      <div className="et-num" style={{ fontSize: big?28:22, fontWeight:600, color:'var(--et-ink)', lineHeight:1.1 }}>{value}</div>
      {sub && <div className="et-meta" style={{ color:'var(--et-mute)' }}>{sub}</div>}
    </div>
  );
}

function RhythmCard({ friend }) {
  return (
    <div style={{
      padding:'24px 26px', background:'var(--et-paper)',
      border:'0.5px solid var(--et-line-2)', borderRadius:'var(--et-r)',
    }}>
      <div className="et-eyebrow">互动节奏</div>
      <div className="et-h2" style={{ marginTop:6, color:'var(--et-ink)' }}>谁更主动？</div>
      <div style={{ marginTop:18, display:'grid', gridTemplateColumns:'auto 1fr', gap:24, alignItems:'center' }}>
        <RingChart you={52} them={48} size={150}/>
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          <Bar label="你" pct={52} count={1552} color="var(--et-orange)"/>
          <Bar label={friend.name} pct={48} count={1453} color="var(--et-ink)"/>
          <div style={{ height:1, background:'var(--et-line)', margin:'4px 0' }}/>
          <div style={{ display:'flex', gap:14, fontSize:12, color:'var(--et-mute)' }}>
            <span>主动开聊 · 你 <b className="et-num" style={{ color:'var(--et-ink)' }}>62</b> 次</span>
            <span>· {friend.name} <b className="et-num" style={{ color:'var(--et-ink)' }}>41</b> 次</span>
          </div>
          <div style={{ fontSize:12, color:'var(--et-mute)' }}>1 分钟内秒回 · <b className="et-num" style={{ color:'var(--et-orange)' }}>248</b> 次</div>
        </div>
      </div>
      <div style={{ marginTop:20, display:'flex', gap:10 }}>
        <StatTile label="最常聊天时段" value="13—15 时" sub="午饭后到下午茶之间"/>
        <StatTile label="深夜比例" value="18%" sub="23—3 时占总消息"/>
        <StatTile label="中位回复" value="2.4 分钟" sub="比你和其他人平均快 5×"/>
      </div>
    </div>
  );
}

function Bar({ label, pct, count, color }) {
  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:4 }}>
        <span style={{ fontSize:13, color:'var(--et-ink)', fontWeight:500 }}>{label}</span>
        <span className="et-num" style={{ fontSize:13, color:'var(--et-mute)' }}>{count.toLocaleString()} 条 · {pct}%</span>
      </div>
      <div style={{ height:6, background:'rgba(26,43,74,0.08)', borderRadius:999, overflow:'hidden' }}>
        <div style={{ width:`${pct}%`, height:'100%', background:color, borderRadius:999 }}/>
      </div>
    </div>
  );
}

function MomentsCard() {
  const moments = [
    { date:'2025·08·14', from:'kevin', text:'我请你吃饭吧 周五怎么样' },
    { date:'2025·06·02', from:'你',    text:'凌晨三点破窗⽽⼊救你的猫' },
    { date:'2025·11·09', from:'kevin', text:'今天好像被偷拍了 你看像不像我' },
    { date:'2025·03·21', from:'你',    text:'刚好路过你公司，要不要下来吃个⼩笼包' },
  ];
  return (
    <div style={{
      padding:'24px 26px', background:'var(--et-paper)',
      border:'0.5px solid var(--et-line-2)', borderRadius:'var(--et-r)',
    }}>
      <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between' }}>
        <div>
          <div className="et-eyebrow">难忘瞬间 · 自动挑选</div>
          <div className="et-h2" style={{ marginTop:6, color:'var(--et-ink)' }}>那些值得回头看的话。</div>
        </div>
        <button style={{ all:'unset', cursor:'pointer', fontSize:12, color:'var(--et-orange)', fontWeight:500 }}>展开更多 →</button>
      </div>
      <div style={{ marginTop:18, display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
        {moments.map((m, i) => <MessageCard key={i} {...m} accent={i%2 ? 'var(--et-ink)' : 'var(--et-orange)'} />)}
      </div>
    </div>
  );
}

function ActionDock({ onExportAI }) {
  const Btn = ({ icon, label, sub, primary, onClick }) => (
    <button onClick={onClick} style={{
      all:'unset', cursor:'pointer',
      flex:1, padding:'14px 18px',
      background: primary ? 'var(--et-ink)' : 'var(--et-paper)',
      color: primary ? 'var(--et-paper)' : 'var(--et-ink)',
      border: primary ? 'none' : '0.5px solid var(--et-line-2)',
      borderRadius:'var(--et-r)',
      display:'flex', alignItems:'center', gap:12,
    }}>
      <div style={{
        width:34, height:34, borderRadius:8,
        background: primary ? 'var(--et-orange)' : 'var(--et-orange-soft)',
        color: primary ? '#fff' : 'var(--et-orange-2)',
        display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, flexShrink:0,
      }}>{icon}</div>
      <div style={{ minWidth:0 }}>
        <div style={{ fontSize:14, fontWeight:600 }}>{label}</div>
        <div style={{ fontSize:11, opacity:primary?0.7:1, color:primary?'var(--et-paper)':'var(--et-mute)', marginTop:2 }}>{sub}</div>
      </div>
    </button>
  );
  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12 }}>
      <Btn icon="📖" label="完整聊天记录" sub="按月份折叠"/>
      <Btn icon="📤" label="导出聊天" sub="单文件 .md / .json"/>
      <Btn icon="💑" label="生成双人年报" sub="一张可分享的卡片"/>
      <Btn icon="🤖" label="导出 AI 分析包" sub="一键打包给 AI 看" primary onClick={onExportAI}/>
    </div>
  );
}

function FriendPage({ friend, onBack, onExportAI }) {
  return (
    <div className="et-root" style={{ background:'var(--et-bg)', minHeight:'100%' }}>
      <FriendChromeBar onBack={onBack} friend={friend}/>
      <div style={{ padding:'24px 28px 32px', display:'flex', flexDirection:'column', gap:18, maxWidth:1180, margin:'0 auto' }}>
        <PersonCard friend={friend}/>
        {/* stats strip */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:12 }}>
          <StatTile label="总消息" value={friend.count.toLocaleString()} sub="一年内 · 含图文/语音" big/>
          <StatTile label="时间跨度" value="182 天" sub="第一次 → 最近一次"/>
          <StatTile label="最长沉默" value="11 天" sub="2025·09·12 起"/>
          <StatTile label="代表语气词" value="「哈哈哈哈」" sub="共出现 412 次"/>
        </div>
        <RhythmCard friend={friend}/>
        <MomentsCard/>
        <ActionDock onExportAI={onExportAI}/>
        <div className="et-meta" style={{ textAlign:'center', color:'var(--et-faint)', marginTop:8 }}>
          — 这一页只你看得见。EchoTrace 不会把任何内容上传到云端。 —
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { FriendPage });
