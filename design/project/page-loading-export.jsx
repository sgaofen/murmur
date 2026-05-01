// EchoTrace — Loading screen + AI Export dialog (2 screens)
// Globals: LoadingPage, AIExportDialog

function LoadingPage() {
  const [pct, setPct] = React.useState(68);
  React.useEffect(() => {
    const t = setInterval(() => setPct(p => p >= 96 ? 68 : p + 1), 400);
    return () => clearInterval(t);
  }, []);
  const lines = [
    '正在为你重新整理这些年的对话…',
    '把照片、语音、转账都按时间放好…',
    '给老朋友按消息数排个顺序…',
  ];
  const [li, setLi] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setLi(i => (i+1) % lines.length), 3200);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="et-root" style={{
      background:'var(--et-bg)', minHeight:'100%',
      display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
      padding:'48px 24px', position:'relative', overflow:'hidden',
    }}>
      {/* corner stamp */}
      <div style={{ position:'absolute', top:32, right:48, transform:'rotate(8deg)', opacity:0.8 }}>
        <Stamp size={64}/>
      </div>
      <div style={{ position:'absolute', top:32, left:48, display:'flex', alignItems:'center', gap:8 }}>
        <svg width="20" height="20" viewBox="0 0 22 22">
          <circle cx="11" cy="11" r="9.5" fill="none" stroke="var(--et-orange)" strokeWidth="1.2"/>
          <circle cx="11" cy="11" r="5.5" fill="none" stroke="var(--et-orange)" strokeWidth="1.2"/>
          <circle cx="11" cy="11" r="1.6" fill="var(--et-orange)"/>
        </svg>
        <span className="et-serif" style={{ fontSize:15, fontWeight:600, color:'var(--et-ink)' }}>EchoTrace</span>
      </div>
      <ScanFrame size={240} progress={pct/100}/>
      <div className="et-h1" style={{ marginTop:36, color:'var(--et-ink)', textAlign:'center', maxWidth:520 }}>
        {lines[li]}
      </div>
      {/* progress bar */}
      <div style={{ marginTop:28, width:420, maxWidth:'80%' }}>
        <div style={{ height:6, background:'rgba(26,43,74,0.08)', borderRadius:999, overflow:'hidden' }}>
          <div style={{
            width:`${pct}%`, height:'100%',
            background:'linear-gradient(90deg, var(--et-orange) 0%, var(--et-rose) 100%)',
            borderRadius:999, transition:'width .35s ease',
          }}/>
        </div>
        <div style={{ display:'flex', justifyContent:'space-between', marginTop:8 }}>
          <span className="et-meta">大约还有 12 秒</span>
          <span className="et-num" style={{ fontSize:12, color:'var(--et-mute)' }}>{pct}%</span>
        </div>
      </div>
      <div style={{ marginTop:36, padding:'14px 22px',
        background:'var(--et-paper)', border:'0.5px solid var(--et-line-2)',
        borderRadius:'var(--et-r)', maxWidth:480, textAlign:'center' }}>
        <span className="et-serif" style={{ fontSize:14, color:'var(--et-ink-soft)', fontStyle:'italic' }}>
          「这一切都在你的电脑上完成，不会上传任何内容到云端。」
        </span>
      </div>
      <div className="et-meta" style={{ position:'absolute', bottom:24, color:'var(--et-faint)' }}>
        首次会慢一点点 · 之后再打开通常 3 秒之内
      </div>
    </div>
  );
}

// ─── AI Export Dialog ───────────────────────────────────────
function AIExportDialog({ open, onClose, friend }) {
  const [step, setStep] = React.useState(1);
  const [ai, setAi] = React.useState('Claude');
  const [range, setRange] = React.useState('year');
  const [focus, setFocus] = React.useState({ qual:true, rhythm:true, persona:true, emotion:false, topics:false, advice:false });
  React.useEffect(() => { if (open) setStep(1); }, [open]);
  if (!open) return null;
  return (
    <div style={{
      position:'absolute', inset:0, zIndex:10,
      background:'rgba(20,24,42,0.42)',
      backdropFilter:'blur(6px)', WebkitBackdropFilter:'blur(6px)',
      display:'flex', alignItems:'center', justifyContent:'center',
      padding:24,
    }}>
      <div style={{
        width:560, maxWidth:'92%',
        background:'var(--et-paper)', borderRadius:'var(--et-r-lg)',
        boxShadow:'var(--et-shadow-3)',
        border:'0.5px solid var(--et-line-2)',
        overflow:'hidden',
        position:'relative',
      }}>
        {/* paper edge */}
        <div style={{ position:'absolute', left:0, top:0, bottom:0, width:6, background:'var(--et-orange)' }}/>
        {/* close */}
        <button onClick={onClose} style={{
          position:'absolute', top:14, right:14, all:'unset', cursor:'pointer',
          width:28, height:28, borderRadius:8, color:'var(--et-mute)',
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 3l8 8M11 3l-8 8" strokeLinecap="round"/></svg>
        </button>
        {/* header */}
        <div style={{ padding:'22px 28px 0' }}>
          <div className="et-eyebrow" style={{ color:'var(--et-orange)' }}>导出 · 给 AI 分析</div>
          <div className="et-h2" style={{ color:'var(--et-ink)', marginTop:6 }}>
            {step===1 ? `把和 ${friend?.name||'kevin'} 的对话打包成一份分析材料` : '搞定！文件已经准备好。'}
          </div>
        </div>
        {step===1 ? (
          <ExportStep1
            ai={ai} setAi={setAi}
            range={range} setRange={setRange}
            focus={focus} setFocus={setFocus}
            onNext={()=>setStep(2)}
          />
        ) : (
          <ExportStep2 onClose={onClose} friend={friend}/>
        )}
      </div>
    </div>
  );
}

function ExportStep1({ ai, setAi, range, setRange, focus, setFocus, onNext }) {
  const ais = ['ChatGPT','Claude','豆包','文心一言','DeepSeek','Kimi','通用（任何 AI）'];
  const ranges = [
    { id:'all',  label:'全部聊天记录', sub:'4 年 · 3,005 条' },
    { id:'year', label:'最近一年',     sub:'2025 全年 · 推荐' },
    { id:'cust', label:'自定义时间…',  sub:'选择起止月份' },
  ];
  const focuses = [
    { k:'qual',    label:'关系定性',     hint:'我们到底是什么关系' },
    { k:'rhythm',  label:'互动节奏',     hint:'谁更主动 / 回应速度' },
    { k:'persona', label:'人物画像',     hint:'对方大概是怎样一个人' },
    { k:'emotion', label:'情感曲线',     hint:'热度有没有变化' },
    { k:'topics',  label:'话题演变',     hint:'我们最近在聊什么' },
    { k:'advice',  label:'给我具体建议', hint:'下一步可以做什么' },
  ];
  return (
    <div style={{ padding:'18px 28px 22px' }}>
      <Section step="①" label="选择给哪个 AI 看">
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:8 }}>
          {ais.map(a => (
            <button key={a} onClick={()=>setAi(a)} style={{
              all:'unset', cursor:'pointer', textAlign:'center',
              padding:'10px 6px', borderRadius:10,
              background: ai===a ? 'var(--et-ink)' : 'transparent',
              color: ai===a ? 'var(--et-paper)' : 'var(--et-ink)',
              border:`0.5px solid ${ai===a ? 'var(--et-ink)' : 'var(--et-line-2)'}`,
              fontSize:12, fontWeight: ai===a ? 600 : 500,
              gridColumn: a==='通用（任何 AI）' ? 'span 2' : 'auto',
            }}>{a}</button>
          ))}
        </div>
      </Section>
      <Section step="②" label="数据范围">
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          {ranges.map(r => (
            <button key={r.id} onClick={()=>setRange(r.id)} style={{
              all:'unset', cursor:'pointer',
              padding:'10px 14px', borderRadius:10, display:'flex', alignItems:'center', gap:12,
              border:`0.5px solid ${range===r.id ? 'var(--et-orange)' : 'var(--et-line-2)'}`,
              background: range===r.id ? 'var(--et-orange-soft)' : 'transparent',
            }}>
              <span style={{
                width:14, height:14, borderRadius:'50%',
                border:`1.5px solid ${range===r.id ? 'var(--et-orange)' : 'var(--et-line-2)'}`,
                background:'var(--et-paper)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
              }}>
                {range===r.id && <span style={{ width:6, height:6, borderRadius:'50%', background:'var(--et-orange)' }}/>}
              </span>
              <span style={{ fontSize:13, fontWeight:500, color:'var(--et-ink)' }}>{r.label}</span>
              <span className="et-meta" style={{ marginLeft:'auto' }}>{r.sub}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section step="③" label="分析侧重">
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          {focuses.map(f => (
            <label key={f.k} style={{
              display:'flex', alignItems:'center', gap:10,
              padding:'8px 12px', borderRadius:10, cursor:'pointer',
              border:`0.5px solid ${focus[f.k] ? 'rgba(224,83,46,0.4)' : 'var(--et-line-2)'}`,
              background: focus[f.k] ? 'var(--et-orange-soft)' : 'transparent',
            }}>
              <span style={{
                width:14, height:14, borderRadius:4, flexShrink:0,
                border:`1.5px solid ${focus[f.k] ? 'var(--et-orange)' : 'var(--et-line-2)'}`,
                background: focus[f.k] ? 'var(--et-orange)' : 'transparent',
                color:'#fff', display:'flex', alignItems:'center', justifyContent:'center',
              }}>
                {focus[f.k] && <svg width="9" height="9" viewBox="0 0 9 9"><path d="M1.5 4.5L3.6 6.6L7.5 2.5" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>}
              </span>
              <input type="checkbox" checked={focus[f.k]} onChange={()=>setFocus({ ...focus, [f.k]: !focus[f.k] })} style={{ display:'none' }}/>
              <div>
                <div style={{ fontSize:13, fontWeight:500, color:'var(--et-ink)' }}>{f.label}</div>
                <div className="et-meta" style={{ fontSize:11 }}>{f.hint}</div>
              </div>
            </label>
          ))}
        </div>
      </Section>
      <button onClick={onNext} style={{
        all:'unset', cursor:'pointer', display:'block', width:'100%', textAlign:'center',
        padding:'14px 0', marginTop:8,
        background:'var(--et-orange)', color:'#fff',
        borderRadius:'var(--et-r)', fontSize:14, fontWeight:600,
        boxShadow:'0 6px 16px rgba(255,107,71,0.32)',
      }}>生成并打开文件夹</button>
    </div>
  );
}

function Section({ step, label, children }) {
  return (
    <div style={{ marginBottom:18 }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:10 }}>
        <span className="et-serif" style={{ fontSize:15, fontWeight:600, color:'var(--et-orange)' }}>{step}</span>
        <span style={{ fontSize:13, fontWeight:600, color:'var(--et-ink)' }}>{label}</span>
      </div>
      {children}
    </div>
  );
}

function ExportStep2({ onClose, friend }) {
  const opts = [
    { c:'#48a76b', label:'直接拖进 ChatGPT/豆包 等聊天框', sub:'AI 会自己读完并给出分析。最简单。', cta:'打开桌面' },
    { c:'#d99a2b', label:'复制全文到聊天框',                sub:'共约 18,000 字，内含 prompt 和摘要数据。', cta:'一键复制全部内容' },
    { c:'var(--et-sky)', label:'在文件管理器里查看',         sub:'打开后可以再编辑、再分享。', cta:'打开文件夹' },
  ];
  return (
    <div style={{ padding:'18px 28px 22px' }}>
      <div style={{
        display:'flex', alignItems:'center', gap:12,
        padding:'14px 16px', borderRadius:'var(--et-r)',
        background:'var(--et-orange-soft)', border:'0.5px dashed rgba(224,83,46,0.36)',
        marginBottom:18,
      }}>
        <div style={{
          width:36, height:36, borderRadius:'50%',
          background:'var(--et-orange)', color:'#fff',
          display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, flexShrink:0,
        }}>✓</div>
        <div style={{ minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:600, color:'var(--et-ink)' }}>已生成：与{friend?.name||'kevin'}的关系档案_AI分析包.md</div>
          <div className="et-meta" style={{ fontFamily:'var(--et-mono)', marginTop:2 }}>~/Desktop/EchoTrace/2025/与kevin的关系档案_AI分析包.md · 287 KB</div>
        </div>
      </div>
      <div style={{ fontSize:13, fontWeight:600, color:'var(--et-ink)', marginBottom:10 }}>接下来三选一：</div>
      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
        {opts.map((o, i) => (
          <div key={i} style={{
            display:'flex', alignItems:'center', gap:14,
            padding:'14px 16px', borderRadius:12,
            background:'var(--et-paper-2)', border:'0.5px solid var(--et-line-2)',
          }}>
            <div style={{ width:10, height:10, borderRadius:'50%', background:o.c, flexShrink:0 }}/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:600, color:'var(--et-ink)' }}>{o.label}</div>
              <div className="et-meta" style={{ marginTop:2 }}>{o.sub}</div>
            </div>
            <button style={{
              all:'unset', cursor:'pointer',
              padding:'7px 14px', borderRadius:8,
              background:'var(--et-ink)', color:'var(--et-paper)',
              fontSize:12, fontWeight:600, whiteSpace:'nowrap', flexShrink:0,
            }}>{o.cta}</button>
          </div>
        ))}
      </div>
      <div className="et-meta" style={{ marginTop:16, color:'var(--et-mute)', textAlign:'center' }}>
        小提示：文件已包含分析提示词，你不需要再向 AI 输入任何东西。
      </div>
      <button onClick={onClose} style={{
        all:'unset', cursor:'pointer', display:'block', margin:'14px auto 0',
        padding:'8px 18px', fontSize:12, color:'var(--et-mute)',
      }}>关闭</button>
    </div>
  );
}

Object.assign(window, { LoadingPage, AIExportDialog });
