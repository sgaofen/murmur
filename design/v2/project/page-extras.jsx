// EchoTrace v2 additions: Media Gallery tab, Local AI agent panel, Task Center drawer.
// Globals: MediaGallery, LocalAgentPanel, AgentAnalyzing, AgentReport, TaskCenterBell, TaskCenterDrawer

// ─── Mock photo data ───────────────────────────────────────
const _hueA = (i) => (i * 47) % 360;
const _seed = (i) => 100 + i * 13;
function _thumb(i, kind) {
  const h = _hueA(i);
  const grad = `linear-gradient(${(_seed(i)*7)%360}deg, hsl(${h},62%,72%), hsl(${(h+50)%360},58%,52%))`;
  const overlays = [
    'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.5), transparent 50%)',
    'linear-gradient(120deg, rgba(0,0,0,0.0) 40%, rgba(0,0,0,0.18) 100%)',
  ];
  return { kind, grad: `${overlays.join(', ')}, ${grad}`, hue:h };
}
const MEDIA_GROUPS = [
  { month:'2026 · 4 月', items:[
    { ..._thumb(1,'img'), msgs:4, time:'04·22 14:08', from:'你' },
    { ..._thumb(2,'img'), msgs:1, time:'04·19 09:24', from:'kevin' },
    { ..._thumb(3,'vid'), dur:'0:12', time:'04·17 23:51', from:'kevin' },
    { ..._thumb(4,'img'), msgs:7, time:'04·15 19:03', from:'kevin' },
    { ..._thumb(5,'img'), msgs:0, time:'04·11 12:42', from:'你' },
    { ..._thumb(6,'img'), msgs:2, time:'04·08 21:30', from:'kevin' },
    { ..._thumb(7,'vid'), dur:'0:43', time:'04·05 16:18', from:'你' },
    { ..._thumb(8,'img'), msgs:3, time:'04·02 11:50', from:'kevin' },
  ]},
  { month:'2026 · 3 月', items:[
    { ..._thumb(9,'img'),  msgs:1, time:'03·30 18:24', from:'kevin' },
    { ..._thumb(10,'img'), msgs:5, time:'03·28 22:01', from:'你' },
    { ..._thumb(11,'img'), msgs:2, time:'03·26 13:44', from:'kevin' },
    { ..._thumb(12,'vid'), dur:'1:02', time:'03·22 19:15', from:'kevin' },
    { ..._thumb(13,'img'), msgs:0, time:'03·19 09:08', from:'你' },
    { ..._thumb(14,'img'), msgs:8, time:'03·14 21:30', from:'kevin' },
    { ..._thumb(15,'img'), msgs:1, time:'03·11 16:00', from:'kevin' },
    { ..._thumb(16,'img'), msgs:0, time:'03·07 12:18', from:'你' },
  ]},
  { month:'2026 · 2 月', items:[
    { ..._thumb(17,'img'), msgs:2, time:'02·24 20:11', from:'kevin' },
    { ..._thumb(18,'img'), msgs:0, time:'02·19 14:32', from:'你' },
    { ..._thumb(19,'vid'), dur:'0:08', time:'02·14 23:58', from:'kevin' },
    { ..._thumb(20,'img'), msgs:3, time:'02·09 18:42', from:'kevin' },
  ]},
];

function MediaThumb({ item, idx, onClick }) {
  return (
    <div onClick={()=>onClick && onClick(item)} style={{
      position:'relative', aspectRatio:'1 / 1', borderRadius:8, overflow:'hidden',
      cursor:'pointer', background: item.grad,
      boxShadow:'inset 0 0 0 0.5px rgba(26,43,74,0.10)',
    }}>
      {/* video badge */}
      {item.kind==='vid' && (
        <div style={{
          position:'absolute', top:8, left:8,
          padding:'2px 7px', borderRadius:4,
          background:'rgba(20,24,42,0.7)', color:'#fff',
          fontSize:10, fontWeight:600, letterSpacing:'0.06em',
          fontFamily:'var(--et-sans)',
        }}>视频</div>
      )}
      {/* play glyph for video */}
      {item.kind==='vid' && (
        <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{
            width:36, height:36, borderRadius:'50%',
            background:'rgba(255,255,255,0.92)', display:'flex', alignItems:'center', justifyContent:'center',
            boxShadow:'0 4px 12px rgba(0,0,0,0.2)',
          }}>
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 2v10l9-5z" fill="#1A2B4A"/></svg>
          </div>
        </div>
      )}
      {/* corner badge: msgs or duration */}
      <div style={{
        position:'absolute', bottom:6, right:6,
        padding:'2px 7px', borderRadius:4,
        background:'rgba(20,24,42,0.7)', color:'#fff',
        fontSize:10, fontWeight:600, fontFamily:'var(--et-mono)',
        display:'flex', alignItems:'center', gap:4,
      }}>
        {item.kind==='vid' ? <>▶ {item.dur}</> :
         item.msgs>0 ? <>💬 {item.msgs}</> : <>·</>}
      </div>
      {/* hover meta */}
      <div className="media-hover" style={{
        position:'absolute', inset:0,
        background:'linear-gradient(180deg, rgba(20,24,42,0) 40%, rgba(20,24,42,0.78) 100%)',
        opacity:0, transition:'opacity .15s ease',
        display:'flex', alignItems:'flex-end', padding:8,
        color:'#fff', fontSize:10.5, fontFamily:'var(--et-sans)', lineHeight:1.3,
      }}>
        <div>
          <div style={{ fontWeight:600 }}>{item.from} 发送</div>
          <div style={{ opacity:0.85 }}>{item.time}</div>
        </div>
      </div>
    </div>
  );
}

function MediaGallery({ friend }) {
  const [tab, setTab] = React.useState('media');
  return (
    <div className="et-root" style={{ background:'var(--et-bg)', minHeight:'100%' }}>
      <style>{`.media-hover-wrap:hover .media-hover { opacity: 1 !important; }`}</style>
      {/* tab strip */}
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'14px 28px 0',
      }}>
        <div style={{ display:'flex', gap:4 }}>
          {[['story','故事'],['media','相册'],['chat','完整对话']].map(([id,label]) => (
            <button key={id} onClick={()=>setTab(id)} style={{
              all:'unset', cursor:'pointer', padding:'8px 16px', borderRadius:'10px 10px 0 0',
              fontFamily:'var(--et-serif)', fontSize:14, fontWeight: id===tab ? 600 : 500,
              color: id===tab ? 'var(--et-ink)' : 'var(--et-mute)',
              background: id===tab ? 'var(--et-paper)' : 'transparent',
              borderBottom: id===tab ? '2px solid var(--et-orange)' : '2px solid transparent',
            }}>{label}</button>
          ))}
        </div>
        <div style={{
          display:'flex', alignItems:'center', gap:8,
          padding:'7px 12px', border:'0.5px solid var(--et-line-2)', borderRadius:999,
          background:'var(--et-paper)', minWidth:260,
        }}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="var(--et-mute)" strokeWidth="1.4">
            <circle cx="5.5" cy="5.5" r="4"/><path d="M8.5 8.5l3 3" strokeLinecap="round"/>
          </svg>
          <input placeholder='在相册里搜对话上下文 · 例如「火锅」' style={{ all:'unset', flex:1, fontSize:12, color:'var(--et-ink)' }}/>
        </div>
      </div>
      <div style={{ borderBottom:'0.5px solid var(--et-line-2)', margin:'0 28px' }}/>
      {/* small intro */}
      <div style={{ padding:'18px 28px 0', display:'flex', alignItems:'baseline', gap:14 }}>
        <div className="et-eyebrow">相册 · 你和 {friend.name}</div>
        <div className="et-meta">共 <span className="et-num" style={{ color:'var(--et-ink)', fontWeight:600 }}>148</span> 张图 · <span className="et-num" style={{ color:'var(--et-ink)', fontWeight:600 }}>16</span> 条视频</div>
      </div>
      {/* groups */}
      <div style={{ padding:'18px 28px 36px', display:'flex', flexDirection:'column', gap:28 }}>
        {MEDIA_GROUPS.map(g => (
          <div key={g.month}>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12 }}>
              <div className="et-serif" style={{ fontSize:16, fontWeight:600, color:'var(--et-ink)' }}>{g.month}</div>
              <div style={{ flex:1, height:1, background:'var(--et-line-2)' }}/>
              <div className="et-meta">{g.items.length} 项</div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10 }}>
              {g.items.map((it, i) => (
                <div key={i} className="media-hover-wrap" style={{ position:'relative' }}>
                  <MediaThumb item={it} idx={i}/>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Local Agent Panel (replaces step1 top section) ────────
function LocalAgentPanel({ value, onChange }) {
  const agents = [
    { id:'cc',    name:'Claude Code',  vendor:'Anthropic · v1.x', desc:'我电脑上的 Claude，最聪明的助手', icon:'C' },
    { id:'codex', name:'Codex CLI',    vendor:'OpenAI · v0.x',     desc:'OpenAI 出的命令行助手',       icon:'O' },
  ];
  return (
    <div style={{
      padding:'14px 16px',
      background:'linear-gradient(180deg, var(--et-orange-soft), transparent 90%)',
      border:'0.5px solid rgba(224,83,46,0.28)',
      borderRadius:'var(--et-r)', marginBottom:18,
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
        <span style={{ fontSize:14 }}>✨</span>
        <div className="et-serif" style={{ fontSize:14, fontWeight:600, color:'var(--et-ink)' }}>
          检测到你电脑上有 <span style={{ color:'var(--et-orange)' }}>2</span> 个 AI 助手 — 直接调用吧
        </div>
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        {agents.map(a => (
          <button key={a.id} onClick={()=>onChange(a.id)} style={{
            all:'unset', cursor:'pointer',
            display:'flex', alignItems:'center', gap:12,
            padding:'10px 12px', borderRadius:10,
            background: value===a.id ? 'var(--et-paper)' : 'rgba(255,255,255,0.45)',
            border:`0.5px solid ${value===a.id ? 'var(--et-orange)' : 'rgba(26,43,74,0.10)'}`,
            boxShadow: value===a.id ? '0 1px 0 rgba(255,255,255,0.6) inset, 0 4px 12px rgba(255,107,71,0.14)' : 'none',
          }}>
            <span style={{
              width:14, height:14, borderRadius:'50%',
              border:`1.5px solid ${value===a.id ? 'var(--et-orange)' : 'var(--et-line-2)'}`,
              background:'var(--et-paper)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
            }}>
              {value===a.id && <span style={{ width:6, height:6, borderRadius:'50%', background:'var(--et-orange)' }}/>}
            </span>
            <span style={{
              width:30, height:30, borderRadius:8,
              background:'var(--et-ink)', color:'var(--et-paper)',
              fontFamily:'var(--et-serif)', fontWeight:600, fontSize:13,
              display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
            }}>{a.icon}</span>
            <div style={{ minWidth:0, flex:1 }}>
              <div style={{ display:'flex', alignItems:'baseline', gap:8 }}>
                <span style={{ fontSize:13, fontWeight:600, color:'var(--et-ink)' }}>{a.name}</span>
                <span className="et-meta" style={{ fontFamily:'var(--et-mono)', fontSize:11 }}>{a.vendor}</span>
              </div>
              <div className="et-meta" style={{ marginTop:2 }}>「{a.desc}」</div>
            </div>
            {value===a.id && (
              <span style={{
                padding:'5px 10px', borderRadius:6,
                background:'var(--et-orange)', color:'#fff',
                fontSize:11, fontWeight:600, whiteSpace:'nowrap',
              }}>让它分析 →</span>
            )}
          </button>
        ))}
      </div>
      <div className="et-meta" style={{ marginTop:10, fontSize:11, color:'var(--et-mute)', display:'flex', alignItems:'center', gap:6 }}>
        <span style={{ width:6, height:6, borderRadius:'50%', background:'#48a76b' }}/>
        全程在本地运行 · 数据不会离开你的电脑
      </div>
    </div>
  );
}

// ─── Agent analyzing (streaming bubble) ─────────────────────
function AgentAnalyzing({ friend }) {
  const lines = [
    '我先快速过一遍你和 ' + friend.name + ' 的对话数据 …',
    '看到几个有意思的信号：',
    '· 你们晚上 1—3 点聊得最多，几乎是其他时段的两倍',
    '· kevin 主动开聊的次数比你多 50%（62 次 vs 41 次）',
    '· 你的回复中位数是 2.4 分钟，对你来说算非常快',
    '· 8 月之后聊天频率上升了 28%，看起来有什么变化',
    '让我抽样几段代表性对话再下判断…',
  ];
  const [shown, setShown] = React.useState(0);
  const [partial, setPartial] = React.useState('');
  React.useEffect(() => {
    if (shown >= lines.length) return;
    const target = lines[shown];
    let i = 0;
    const t = setInterval(() => {
      i += 2;
      if (i >= target.length) {
        setPartial(target);
        clearInterval(t);
        setTimeout(() => { setShown(s => s + 1); setPartial(''); }, 500);
      } else {
        setPartial(target.slice(0, i));
      }
    }, 28);
    return () => clearInterval(t);
  }, [shown]);
  const [secs, setSecs] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(()=>setSecs(s=>s+1), 1000);
    return ()=>clearInterval(t);
  }, []);

  return (
    <div className="et-root" style={{ background:'var(--et-bg)', minHeight:'100%', padding:'28px 28px 32px' }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:10, marginBottom:14 }}>
        <span style={{
          width:10, height:10, borderRadius:'50%', background:'var(--et-orange)',
          animation:'et-pulse 1.4s ease-in-out infinite',
        }}/>
        <div className="et-h2" style={{ color:'var(--et-ink)' }}>Claude Code 正在分析 与 {friend.name} 的关系</div>
      </div>
      <style>{`@keyframes et-pulse{0%,100%{opacity:.4}50%{opacity:1}} @keyframes et-blink{50%{opacity:0}}`}</style>
      <div style={{
        background:'var(--et-paper)', border:'0.5px solid var(--et-line-2)',
        borderRadius:'var(--et-r-lg)', padding:'22px 26px',
        boxShadow:'var(--et-shadow-1)', position:'relative', minHeight:280,
      }} className="et-paper-grain">
        <div style={{ position:'absolute', top:18, right:22 }}>
          <span className="et-chip">Claude Code · 流式输出</span>
        </div>
        <div className="et-eyebrow">助手发言</div>
        <div className="et-serif" style={{ marginTop:14, fontSize:15, lineHeight:1.85, color:'var(--et-ink)' }}>
          {lines.slice(0, shown).map((l, i) => (
            <div key={i} style={{ marginBottom:8 }}>{l}</div>
          ))}
          {shown < lines.length && (
            <div>{partial}<span style={{ display:'inline-block', width:8, height:16, background:'var(--et-orange)', marginLeft:2, verticalAlign:'middle', animation:'et-blink 1s steps(1) infinite' }}/></div>
          )}
        </div>
        {/* progress strip */}
        <div style={{ marginTop:22, paddingTop:16, borderTop:'0.5px solid var(--et-line)', display:'flex', alignItems:'center', gap:14 }}>
          <div className="et-meta">已用时 <span className="et-num" style={{ color:'var(--et-ink)', fontWeight:600 }}>{secs}s</span></div>
          <div className="et-meta">· 已读取 <span className="et-num" style={{ color:'var(--et-ink)', fontWeight:600 }}>{Math.min(80, Math.round(secs*4.2))}</span> 条样本</div>
          <div style={{ flex:1, height:4, background:'rgba(26,43,74,0.08)', borderRadius:999, overflow:'hidden' }}>
            <div style={{ width: `${Math.min(95, secs*5)}%`, height:'100%', background:'var(--et-orange)', borderRadius:999, transition:'width .3s' }}/>
          </div>
          <button style={{ all:'unset', cursor:'pointer', fontSize:12, color:'var(--et-mute)', padding:'5px 10px', borderRadius:6 }}>打开完整对话</button>
          <button style={{ all:'unset', cursor:'pointer', fontSize:12, color:'var(--et-orange)', fontWeight:600, padding:'5px 10px', borderRadius:6, border:'0.5px solid rgba(224,83,46,0.3)' }}>停止</button>
        </div>
      </div>
    </div>
  );
}

// ─── Agent finished — magazine-style report ────────────────
function AgentReport({ friend }) {
  return (
    <div className="et-root" style={{ background:'var(--et-bg)', minHeight:'100%' }}>
      <div style={{ padding:'28px 28px 0', display:'flex', alignItems:'center', gap:10 }}>
        <button style={{ all:'unset', cursor:'pointer', fontSize:13, color:'var(--et-mute)', display:'flex', alignItems:'center', gap:6 }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2L3 7l5 5" strokeLinecap="round"/></svg>
          返回
        </button>
        <div className="et-meta" style={{ marginLeft:'auto' }}>已生成 · 引用了 80 条消息</div>
      </div>
      {/* hero / cover */}
      <div style={{
        margin:'18px 28px 0', padding:'40px 44px',
        background:'var(--et-paper)', border:'0.5px solid var(--et-line-2)',
        borderRadius:'var(--et-r-lg)', boxShadow:'var(--et-shadow-2)', position:'relative', overflow:'hidden',
      }} className="et-paper-grain">
        <div style={{ position:'absolute', inset:14, border:'0.5px solid var(--et-line)', borderRadius:14, pointerEvents:'none' }}/>
        <div style={{ position:'absolute', top:24, right:30, transform:'rotate(-7deg)' }}>
          <Postmark size={92} text1='CLAUDE CODE' text2='本地分析 · 私人专用' date='2026·04·30'/>
        </div>
        <Ribbon color="var(--et-orange)" tone="solid">精装分析报告 · No.01</Ribbon>
        <div className="et-display" style={{ marginTop:22, color:'var(--et-ink)', maxWidth:760 }}>
          与 {friend.name} 的<br/>关系画像
        </div>
        <div className="et-meta" style={{ marginTop:14, fontSize:13 }}>
          由 <b style={{ color:'var(--et-ink)' }}>Claude Code</b> 撰写 · 2026·04·30 · 引用了 <b className="et-num" style={{ color:'var(--et-ink)' }}>80</b> 条消息 · 用时 32 秒
        </div>
      </div>
      {/* chapters */}
      <div style={{ padding:'24px 28px 32px', display:'flex', flexDirection:'column', gap:18, maxWidth:1180, margin:'0 auto' }}>
        <ReportChapter num="01" title="关系定性" body="你们大概率是‘成年后还在保持高频率联系的少数好友’。不是亲密恋人级，但远高于普通同学/同事。你们之间有一种‘无需寒暄即可继续’的熟悉感——81% 的对话不是从问候开始的。"/>
        <ReportChapter num="02" title="互动节奏" body="kevin 主动开启对话的次数（62 次）是你的 1.5 倍，但你回得更快——中位数 2.4 分钟，他是 6.1 分钟。这是一种‘他撒网，你接住’的稳定模式。" quote={{ from:'kevin', date:'2025·08·14 23:14', text:'诶我请你吃饭吧 周五怎么样' }}/>
        <ReportChapter num="03" title="关键时刻" body="2025 年 8 月之后聊天量显著上升（+28%）。结合内容，疑似 kevin 工作变动期。你在那段时间几乎每条消息都在 5 分钟内回。" quote={{ from:'你', date:'2025·08·31 02:08', text:'其实你已经做得很好了 别再⾃责' }}/>
        <ReportChapter num="04" title="人物画像" body="kevin 是表达型 + 夜行型 + 高情感投入。他用「哈哈哈哈」的频率是平均水平的 2.3 倍，倾向用图片代替长文字解释。他的语气词随时间变化明显——年初偏稳重，年末偏松弛。"/>
        <ReportChapter num="05" title="关系走向" body="近 30 天的互动密度并未下降，但从你回复的语气来看，你的状态比 kevin 紧张。建议：可以主动发起一次具体的线下计划，他回应概率 > 90%。"/>
      </div>
      {/* dock */}
      <div style={{ margin:'0 28px 32px', display:'flex', gap:10, justifyContent:'center' }}>
        <ReportBtn label="导出 PDF" icon="↓"/>
        <ReportBtn label="拷贝全文" icon="⎘"/>
        <ReportBtn label="再来一次" icon="↻"/>
        <ReportBtn primary label="询问后续问题…" icon="✦"/>
      </div>
    </div>
  );
}
function ReportChapter({ num, title, body, quote }) {
  return (
    <div style={{
      background:'var(--et-paper)', border:'0.5px solid var(--et-line-2)',
      borderRadius:'var(--et-r)', padding:'24px 28px', display:'grid',
      gridTemplateColumns:'56px 1fr', gap:18,
    }}>
      <div className="et-serif" style={{ fontSize:32, fontWeight:600, color:'var(--et-orange)', lineHeight:1, fontVariantNumeric:'tabular-nums' }}>{num}</div>
      <div>
        <div className="et-h2" style={{ color:'var(--et-ink)' }}>{title}</div>
        <div className="et-body" style={{ marginTop:10, fontSize:14.5, lineHeight:1.78, color:'var(--et-ink-soft)', maxWidth:720 }}>{body}</div>
        {quote && (
          <div style={{ marginTop:14 }}>
            <MessageCard from={quote.from} date={quote.date} text={quote.text}/>
          </div>
        )}
      </div>
    </div>
  );
}
function ReportBtn({ label, icon, primary }) {
  return (
    <button style={{
      all:'unset', cursor:'pointer',
      padding:'10px 18px', borderRadius:10,
      background: primary ? 'var(--et-orange)' : 'var(--et-paper)',
      color: primary ? '#fff' : 'var(--et-ink)',
      border: primary ? 'none' : '0.5px solid var(--et-line-2)',
      fontSize:13, fontWeight:600,
      display:'inline-flex', alignItems:'center', gap:8,
      boxShadow: primary ? '0 4px 12px rgba(255,107,71,0.3)' : 'none',
    }}>
      <span style={{ opacity:0.9 }}>{icon}</span>{label}
    </button>
  );
}

// ─── Task Center ───────────────────────────────────────────
const TASK_ICONS = {
  key:    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="4" cy="7" r="2.5"/><path d="M6 7h6M11 7v2.5M9 7v2"/></svg>,
  agent:  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1L4 7h2.5L5.5 13l4-7H7L7 1z" fill="currentColor"/></svg>,
  index:  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 4l2-2h3l1 1h4v8H2V4z"/></svg>,
  lock:   <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="3" y="6" width="8" height="6" rx="1"/><path d="M5 6V4.5a2 2 0 014 0V6"/></svg>,
};

function TaskRow({ task }) {
  const isDone = task.status==='done';
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:12,
      padding:'12px 14px', borderRadius:12,
      background: isDone ? 'transparent' : 'var(--et-paper)',
      border: isDone ? '0.5px dashed var(--et-line-2)' : '0.5px solid var(--et-line-2)',
      opacity: isDone ? 0.65 : 1,
      transition:'transform .15s, box-shadow .2s',
      cursor:'default',
    }}
    onMouseEnter={(e)=>{ if(!isDone){ e.currentTarget.style.transform='translateY(-1px)'; e.currentTarget.style.boxShadow='var(--et-shadow-2)'; } }}
    onMouseLeave={(e)=>{ e.currentTarget.style.transform='none'; e.currentTarget.style.boxShadow='none'; }}
    >
      <div style={{
        width:30, height:30, borderRadius:8,
        background: isDone ? 'rgba(26,43,74,0.06)' : 'var(--et-orange-soft)',
        color: isDone ? 'var(--et-mute)' : 'var(--et-orange-2)',
        display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
      }}>
        {isDone
          ? <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2.5 6.2L4.8 8.5L9.5 3.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
          : TASK_ICONS[task.icon]}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:8 }}>
          <span style={{ fontSize:12.5, fontWeight:600, color: isDone ? 'var(--et-mute)' : 'var(--et-ink)' }}>{task.name}</span>
          {!isDone && <span className="et-num" style={{ fontSize:11, color:'var(--et-mute)' }}>{task.pct}%</span>}
        </div>
        {!isDone && (
          <div style={{ height:4, background:'rgba(26,43,74,0.08)', borderRadius:999, overflow:'hidden', marginTop:6 }}>
            <div style={{ width:`${task.pct}%`, height:'100%', background:'var(--et-orange)', borderRadius:999, transition:'width .25s' }}/>
          </div>
        )}
        <div className="et-meta" style={{ fontSize:11, marginTop:4, color:'var(--et-mute)' }}>{task.sub}</div>
      </div>
      <button style={{
        all:'unset', cursor:'pointer', padding:'4px 10px', borderRadius:6,
        fontSize:11, color: isDone ? 'var(--et-mute)' : 'var(--et-ink)',
        border:'0.5px solid var(--et-line-2)', background:'var(--et-paper)',
      }}>{isDone ? '清除' : task.action || '取消'}</button>
    </div>
  );
}

const SAMPLE_TASKS = [
  { id:1, icon:'lock',  name:'正在解密最新数据',         pct:78, status:'run', sub:'12 个数据库 · 已完成 9 个' },
  { id:2, icon:'agent', name:'Claude Code 正在分析 kevin', pct:12, status:'run', sub:'已读取统计 · 正在挑选样本对话' },
  { id:3, icon:'index', name:'索引完成（12 分钟前）',     pct:100, status:'done', sub:'共建立 8,201 条对话索引' },
];

function TaskCenterDrawer({ tasks=SAMPLE_TASKS, onClose }) {
  return (
    <>
      <div onClick={onClose} style={{
        position:'absolute', inset:0, background:'rgba(20,24,42,0.10)',
        backdropFilter:'blur(2px)', zIndex:20,
      }}/>
      <div style={{
        position:'absolute', top:14, right:62, zIndex:21,
        width:380, background:'var(--et-paper)',
        border:'0.5px solid var(--et-line-2)',
        borderRadius:'var(--et-r)', boxShadow:'var(--et-shadow-3)',
        overflow:'hidden',
      }}>
        {/* arrow */}
        <div style={{
          position:'absolute', top:-7, right:18, width:14, height:14,
          background:'var(--et-paper)', borderTop:'0.5px solid var(--et-line-2)', borderLeft:'0.5px solid var(--et-line-2)',
          transform:'rotate(45deg)',
        }}/>
        <div style={{ padding:'14px 18px', display:'flex', alignItems:'center', justifyContent:'space-between', borderBottom:'0.5px solid var(--et-line)' }}>
          <div className="et-serif" style={{ fontSize:14, fontWeight:600, color:'var(--et-ink)' }}>后台任务</div>
          <div className="et-meta">{tasks.filter(t=>t.status==='run').length} 个进行中 · {tasks.filter(t=>t.status==='done').length} 个已完成</div>
        </div>
        <div style={{ padding:14, display:'flex', flexDirection:'column', gap:10 }}>
          {tasks.map(t => <TaskRow key={t.id} task={t}/>)}
        </div>
        <div style={{ padding:'10px 18px', borderTop:'0.5px solid var(--et-line)', display:'flex', justifyContent:'space-between' }}>
          <button style={{ all:'unset', cursor:'pointer', fontSize:11, color:'var(--et-mute)' }}>全部历史</button>
          <button style={{ all:'unset', cursor:'pointer', fontSize:11, color:'var(--et-orange)', fontWeight:600 }}>清除已完成</button>
        </div>
      </div>
    </>
  );
}

function TaskCenterBell({ count=2, onClick, active }) {
  return (
    <button onClick={onClick} style={{
      all:'unset', cursor:'pointer', position:'relative',
      width:32, height:32, borderRadius:8,
      display:'flex', alignItems:'center', justifyContent:'center',
      background: active ? 'var(--et-orange-soft)' : 'transparent',
      color: active ? 'var(--et-orange-2)' : 'var(--et-mute)',
    }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M8 2v1M4 7a4 4 0 018 0v3l1 2H3l1-2V7zM6.5 13a1.5 1.5 0 003 0" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      {count>0 && (
        <span style={{
          position:'absolute', top:4, right:4,
          minWidth:14, height:14, padding:'0 3px', borderRadius:999,
          background:'var(--et-orange)', color:'#fff',
          fontSize:9, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center',
          fontFamily:'var(--et-sans)',
          boxShadow:'0 0 0 2px var(--et-paper)',
        }}>{count}</span>
      )}
    </button>
  );
}

Object.assign(window, {
  MediaGallery, LocalAgentPanel, AgentAnalyzing, AgentReport,
  TaskCenterBell, TaskCenterDrawer, SAMPLE_TASKS,
});
