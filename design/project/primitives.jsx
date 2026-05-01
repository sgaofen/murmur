// EchoTrace — Shared primitives: avatars, decorative SVGs, friend data.
// Globals (window.ET): Avatar, Stamp, Ribbon, Bookmark, FriendCard, FRIENDS, MONTHS, monthHeat, Sparkline, RingChart, MessageCard, Postmark, ScanFrame.

// ─── Mock data ─────────────────────────────────────────────
const FRIENDS = [
  { id:'kevin',  name:'kevin',     count:3005, last:'昨天 23:41', tag:'夜聊伙伴',  tagKind:'orange', hue:14,  glyph:'K', knew:'认识 4 年',  bond:'⼯作之后还在聊的少数⼈' },
  { id:'double', name:'doubleW',   count:2103, last:'3 天前',     tag:'老朋友',    tagKind:'amber',  hue:36,  glyph:'D', knew:'认识 9 年',  bond:'⾼中同桌⻓出来的友谊' },
  { id:'ashley', name:'Ashley',    count:1510, last:'上周',       tag:'秒回选⼿',  tagKind:'orange', hue:340, glyph:'A', knew:'认识 5 年',  bond:'信息回复永远不超过 3 分钟' },
  { id:'berry',  name:'🍓 莓莓',   count:1376, last:'上周',       tag:'⼼事树洞',  tagKind:'sage',   hue:165, glyph:'莓', knew:'认识 3 年', bond:'凌晨三点会接电话的那个⼈' },
  { id:'whoo',   name:'whoO.O',    count:1297, last:'2 周前',     tag:'梗⼩组⻓', tagKind:'ink',    hue:200, glyph:'W', knew:'认识 6 年',  bond:'⼀起在群⾥发癫的搭⼦' },
  { id:'mom',    name:'妈妈',      count: 980, last:'今天 19:02', tag:'家',         tagKind:'amber',  hue:24,  glyph:'妈', knew:'⼀辈⼦',     bond:'每周都问吃饭了没有' },
  { id:'tao',    name:'⼩涛',      count: 854, last:'昨天',        tag:'饭友',       tagKind:'orange', hue:8,   glyph:'涛', knew:'认识 2 年', bond:'本市最了解外卖店家的⼈' },
  { id:'lin',    name:'林岸',      count: 712, last:'上⽉',        tag:'⽼朋友',     tagKind:'amber',  hue:30,  glyph:'林', knew:'认识 7 年', bond:'毕业之后散落各地' },
  { id:'shu',    name:'阿淑',      count: 661, last:'5 天前',      tag:'剧透合伙⼈', tagKind:'sage',   hue:155, glyph:'淑', knew:'认识 4 年', bond:'交换剧、播客、电影' },
  { id:'jim',    name:'Jimmy 张', count: 540, last:'本⽉初',      tag:'⼯位邻居',   tagKind:'ink',    hue:215, glyph:'J', knew:'认识 1 年', bond:'⼯位⾯对⾯，群⾥才说话' },
  { id:'mei',    name:'梅梅',      count: 487, last:'2 ⽉前',       tag:'久未联系',   tagKind:'faint',  hue:280, glyph:'梅', knew:'认识 8 年', bond:'失联得越来越久' },
  { id:'ban',    name:'阿斑',      count: 412, last:'本周',         tag:'猫主⼈',     tagKind:'sage',   hue:130, glyph:'斑', knew:'认识 3 年', bond:'每天发猫的⼈' },
];

const MONTHS = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const monthHeat = [0.32, 0.41, 0.55, 0.48, 0.62, 0.71, 0.45, 0.92, 0.78, 0.66, 0.83, 0.97];

// ─── Avatar (CSS gradient + monogram) ──────────────────────
function Avatar({ friend, size=56, ring=false, frame=false, style }) {
  const f = friend;
  const grad = `conic-gradient(from ${f.hue}deg at 60% 40%, hsl(${f.hue}, 72%, 64%), hsl(${(f.hue+40)%360}, 80%, 56%), hsl(${(f.hue+80)%360}, 68%, 50%), hsl(${f.hue}, 72%, 64%))`;
  const fs = Math.max(11, Math.round(size * 0.36));
  return (
    <div style={{
      position:'relative', width:size, height:size, flexShrink:0,
      borderRadius: frame ? 6 : '50%',
      background: grad,
      display:'flex', alignItems:'center', justifyContent:'center',
      color:'rgba(255,255,255,0.95)', fontFamily:'var(--et-serif)',
      fontWeight:600, fontSize:fs,
      boxShadow: ring ? '0 0 0 2px var(--et-paper), 0 0 0 3.5px var(--et-orange)'
                       : 'inset 0 -1px 2px rgba(0,0,0,0.10), 0 1px 2px rgba(26,43,74,0.10)',
      letterSpacing:'0.02em',
      ...style,
    }}>
      <span style={{ textShadow:'0 1px 2px rgba(0,0,0,0.18)' }}>{f.glyph}</span>
    </div>
  );
}

// ─── Postage stamp (decorative, hand-drawn feel) ───────────
function Stamp({ size=72, label='ECHOTRACE · 2025', sub='本地寄送 · 不上云', color='var(--et-orange)' }) {
  return (
    <svg width={size} height={size*1.12} viewBox="0 0 72 80" style={{ display:'block' }}>
      <defs>
        <pattern id="stamp-edge" x="0" y="0" width="6" height="6" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="2.5" fill="var(--et-paper)" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="72" height="80" fill={color} />
      <rect x="0" y="0" width="72" height="80" fill="url(#stamp-edge)" />
      <rect x="4" y="4" width="64" height="72" fill="var(--et-paper)" stroke={color} strokeWidth="0.5" />
      {/* stamp inner art */}
      <g transform="translate(36,30)" stroke={color} strokeWidth="1.2" fill="none">
        <circle r="14" />
        <path d="M-9,2 Q-3,-6 0,-6 Q3,-6 9,2 Q3,7 0,7 Q-3,7 -9,2 Z" />
        <circle r="2" fill={color} />
      </g>
      <text x="36" y="56" textAnchor="middle" fontSize="5.5" fontWeight="700" fill={color} fontFamily="var(--et-sans)" letterSpacing="0.08em">{label}</text>
      <text x="36" y="65" textAnchor="middle" fontSize="4.2" fill={color} opacity="0.7" fontFamily="var(--et-sans)" letterSpacing="0.04em">{sub}</text>
      {/* postmark wave */}
      <g transform="translate(54,14) rotate(-18)" stroke={color} strokeWidth="0.5" fill="none" opacity="0.8">
        <circle r="9" />
        <text x="0" y="1.5" textAnchor="middle" fontSize="3.2" fill={color} fontFamily="var(--et-sans)">2025</text>
      </g>
    </svg>
  );
}

// ─── Postmark — circular cancellation stamp ────────────────
function Postmark({ size=92, text1='ECHOTRACE', text2='本地寄送 · 不上云', date='2025·12·31', color='var(--et-postmark)' }) {
  const r1 = size/2 - 1;
  const r2 = r1 - 6;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display:'block' }}>
      <defs>
        <path id={`pm-arc-${size}`} d={`M ${size/2} ${size/2-r1+3} A ${r1-3} ${r1-3} 0 1 1 ${size/2-0.01} ${size/2-r1+3}`} fill="none"/>
        <path id={`pm-arc2-${size}`} d={`M ${size/2-r2+3} ${size/2} A ${r2-3} ${r2-3} 0 0 0 ${size/2+r2-3} ${size/2}`} fill="none"/>
      </defs>
      <circle cx={size/2} cy={size/2} r={r1} fill="none" stroke={color} strokeWidth="1.2" opacity="0.9" />
      <circle cx={size/2} cy={size/2} r={r2} fill="none" stroke={color} strokeWidth="0.6" opacity="0.7" />
      <text fontSize={size*0.10} fontFamily="var(--et-sans)" fontWeight="700" fill={color} letterSpacing="0.2em">
        <textPath href={`#pm-arc-${size}`} startOffset="50%" textAnchor="middle">{text1}</textPath>
      </text>
      <text fontSize={size*0.075} fontFamily="var(--et-sans)" fill={color} letterSpacing="0.1em" opacity="0.85">
        <textPath href={`#pm-arc2-${size}`} startOffset="50%" textAnchor="middle">{text2}</textPath>
      </text>
      <text x={size/2} y={size/2+2} textAnchor="middle" fontSize={size*0.13} fontFamily="var(--et-serif)" fontWeight="600" fill={color}>{date}</text>
      <line x1={size*0.28} y1={size/2+8} x2={size*0.72} y2={size/2+8} stroke={color} strokeWidth="0.6" opacity="0.6" />
    </svg>
  );
}

// ─── Bookmark ribbon — paper accent ────────────────────────
function Bookmark({ width=22, height=70, color='var(--et-orange)', text }) {
  return (
    <div style={{ position:'relative', width, height, flexShrink:0 }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display:'block', filter:'drop-shadow(0 2px 4px rgba(26,43,74,0.18))' }}>
        <path d={`M0,0 L${width},0 L${width},${height} L${width/2},${height-10} L0,${height} Z`} fill={color} />
      </svg>
      {text && (
        <div style={{
          position:'absolute', inset:0, display:'flex', alignItems:'flex-start', justifyContent:'center',
          paddingTop: 8, color:'#fff', fontFamily:'var(--et-serif)', fontSize:11, fontWeight:600,
          writingMode:'vertical-rl', textOrientation:'upright', letterSpacing:'0.1em',
        }}>{text}</div>
      )}
    </div>
  );
}

// ─── Ribbon (banner slash) ─────────────────────────────────
function Ribbon({ children, color='var(--et-orange)', tone='light' }) {
  return (
    <div style={{
      display:'inline-flex', alignItems:'center', gap:8,
      padding:'6px 14px 6px 26px', position:'relative',
      background: tone==='light' ? 'var(--et-paper)' : color,
      color: tone==='light' ? color : '#fff',
      border:`0.5px solid ${tone==='light' ? color : 'transparent'}`,
      fontFamily:'var(--et-sans)', fontSize:11, fontWeight:600, letterSpacing:'0.14em', textTransform:'uppercase',
    }}>
      <span style={{
        position:'absolute', left:8, top:'50%', transform:'translateY(-50%)',
        width:6, height:6, borderRadius:'50%', background:color, boxShadow:`0 0 0 2px ${tone==='light' ? 'var(--et-paper)' : '#fff'}`,
      }}/>
      {children}
    </div>
  );
}

// ─── Friend card (used on Homepage grid) ────────────────────
function FriendCard({ friend, rank, big=false, onClick }) {
  return (
    <div onClick={onClick} style={{
      position:'relative',
      background:'var(--et-paper)',
      border:'0.5px solid var(--et-line-2)',
      borderRadius:'var(--et-r)',
      padding: big ? '20px 22px' : '16px 18px',
      display:'flex', flexDirection:'column', gap:12,
      boxShadow:'var(--et-shadow-1)',
      cursor:'pointer', transition:'transform .15s ease, box-shadow .2s ease',
      overflow:'hidden',
    }}
    onMouseEnter={(e)=>{ e.currentTarget.style.transform='translateY(-2px)'; e.currentTarget.style.boxShadow='var(--et-shadow-2)'; }}
    onMouseLeave={(e)=>{ e.currentTarget.style.transform='translateY(0)';   e.currentTarget.style.boxShadow='var(--et-shadow-1)'; }}
    >
      {/* rank corner */}
      {rank!=null && (
        <div style={{
          position:'absolute', top:0, right:0,
          width:34, height:34,
          background:'var(--et-paper-2)',
          clipPath:'polygon(100% 0, 100% 100%, 0 0)',
        }}/>
      )}
      {rank!=null && (
        <div style={{
          position:'absolute', top:4, right:6,
          fontFamily:'var(--et-serif)', fontWeight:600, fontSize:12, color:'var(--et-mute)',
          fontVariantNumeric:'tabular-nums',
        }}>#{String(rank).padStart(2,'0')}</div>
      )}
      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
        <Avatar friend={friend} size={big?52:42} />
        <div style={{ minWidth:0, flex:1 }}>
          <div style={{ display:'flex', alignItems:'baseline', gap:6 }}>
            <div className="et-h3" style={{ fontSize: big?20:17, fontWeight:600, color:'var(--et-ink)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{friend.name}</div>
          </div>
          <div className="et-meta" style={{ marginTop:2 }}>{friend.last} · {friend.knew}</div>
        </div>
      </div>
      <div style={{ display:'flex', alignItems:'flex-end', justifyContent:'space-between', gap:8 }}>
        <div>
          <div className="et-num" style={{ fontSize: big?28:22, fontWeight:600, color:'var(--et-ink)', lineHeight:1 }}>
            {friend.count.toLocaleString()}
            <span style={{ fontSize:11, fontWeight:500, color:'var(--et-mute)', marginLeft:4, fontFamily:'var(--et-sans)' }}>条</span>
          </div>
          <div className="et-meta" style={{ marginTop:4 }}>{friend.bond}</div>
        </div>
        <span className={`et-chip ${friend.tagKind||''}`}>{friend.tag}</span>
      </div>
    </div>
  );
}

// ─── Sparkline (12-month heat) ─────────────────────────────
function Sparkline({ data=monthHeat, w=560, h=72, color='var(--et-orange)' }) {
  const max = Math.max(...data);
  const bw = w / data.length;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display:'block' }}>
      {data.map((v, i) => {
        const bh = (v/max) * (h-22);
        return (
          <g key={i}>
            <rect x={i*bw + bw*0.18} y={h-bh-12} width={bw*0.64} height={bh} rx="2" fill={color} opacity={0.25 + 0.55 * (v/max)} />
            <text x={i*bw + bw/2} y={h-2} textAnchor="middle" fontSize="9" fill="var(--et-mute)" fontFamily="var(--et-sans)">{MONTHS[i]}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── Ring chart (互动节奏) ─────────────────────────────────
function RingChart({ you=52, them=48, size=140, sizeLabel=12 }) {
  const r = (size-22)/2;
  const c = 2*Math.PI*r;
  const youDash = (you/100)*c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(26,43,74,0.10)" strokeWidth="14"/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--et-orange)" strokeWidth="14" strokeLinecap="round"
        strokeDasharray={`${youDash} ${c-youDash}`} transform={`rotate(-90 ${size/2} ${size/2})`}/>
      <text x={size/2} y={size/2-3} textAnchor="middle" fontFamily="var(--et-serif)" fontSize="22" fontWeight="600" fill="var(--et-ink)">{you}<tspan fontSize="11" fill="var(--et-mute)" fontFamily="var(--et-sans)" fontWeight="500"> %</tspan></text>
      <text x={size/2} y={size/2+14} textAnchor="middle" fontFamily="var(--et-sans)" fontSize={sizeLabel} fill="var(--et-mute)">你说得更多</text>
    </svg>
  );
}

// ─── Quoted message card (难忘瞬间) ─────────────────────────
function MessageCard({ from='kevin', date='2025·08·14', text, accent='var(--et-orange)' }) {
  return (
    <div style={{
      position:'relative', background:'var(--et-paper)',
      border:`0.5px solid var(--et-line-2)`, borderRadius:10,
      padding:'14px 16px 14px 22px', display:'flex', flexDirection:'column', gap:6,
    }}>
      <div style={{ position:'absolute', left:0, top:14, bottom:14, width:3, background:accent, borderRadius:'0 2px 2px 0' }}/>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
        <div className="et-meta" style={{ fontWeight:600, color:'var(--et-ink)' }}>{from}</div>
        <div className="et-meta" style={{ fontFamily:'var(--et-mono)', fontSize:11 }}>{date}</div>
      </div>
      <div className="et-serif" style={{ fontSize:15, lineHeight:1.55, color:'var(--et-ink)' }}>「{text}」</div>
    </div>
  );
}

// ─── Scan / radar animation for loading screen ─────────────
function ScanFrame({ size=220, progress=0.68 }) {
  return (
    <div style={{ position:'relative', width:size, height:size }}>
      <style>{`
        @keyframes et-scan { 0%{transform:rotate(0)} 100%{transform:rotate(360deg)} }
        @keyframes et-pulse { 0%,100%{opacity:.4;transform:scale(.96)} 50%{opacity:.85;transform:scale(1)} }
      `}</style>
      <svg width={size} height={size} viewBox="0 0 220 220" style={{ position:'absolute', inset:0 }}>
        {/* concentric rings */}
        {[40,70,100].map((r,i) => (
          <circle key={i} cx="110" cy="110" r={r} fill="none" stroke="var(--et-line-2)" strokeWidth="0.6" strokeDasharray="2 4"/>
        ))}
        {/* ring tick marks */}
        {Array.from({ length: 36 }).map((_, i) => {
          const a = (i / 36) * Math.PI * 2;
          const x1 = 110 + Math.cos(a) * 96, y1 = 110 + Math.sin(a) * 96;
          const x2 = 110 + Math.cos(a) * 102, y2 = 110 + Math.sin(a) * 102;
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--et-line-2)" strokeWidth="0.5"/>;
        })}
        {/* points = friends being remembered */}
        {[
          [60,72,1.2],[150,55,0.9],[170,140,1.4],[80,160,1.0],[112,95,1.6],
          [135,110,1.1],[52,118,0.8],[160,90,1.0],[90,130,0.9]
        ].map(([x,y,r], i) => (
          <circle key={i} cx={x} cy={y} r={r*1.4} fill="var(--et-orange)" opacity={0.85} style={{ animation:`et-pulse 2s ease-in-out ${i*0.18}s infinite` }} />
        ))}
        {/* center heart */}
        <g transform="translate(110,110)">
          <path d="M0,5 C-6,-2 -10,-2 -10,-6 C-10,-10 -6,-12 -3,-10 C-1.5,-9 0,-7 0,-7 C0,-7 1.5,-9 3,-10 C6,-12 10,-10 10,-6 C10,-2 6,-2 0,5 Z" fill="var(--et-orange)" opacity="0.9"/>
        </g>
      </svg>
      {/* sweeping arm */}
      <div style={{
        position:'absolute', inset:0, animation:'et-scan 5s linear infinite',
      }}>
        <svg width={size} height={size} viewBox="0 0 220 220">
          <defs>
            <linearGradient id="scan-fade" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--et-orange)" stopOpacity="0"/>
              <stop offset="100%" stopColor="var(--et-orange)" stopOpacity="0.5"/>
            </linearGradient>
          </defs>
          <path d="M110,110 L110,12 A98,98 0 0 1 200,84 Z" fill="url(#scan-fade)"/>
        </svg>
      </div>
    </div>
  );
}

Object.assign(window, {
  ET_FRIENDS: FRIENDS, ET_MONTHS: MONTHS, ET_HEAT: monthHeat,
  Avatar, Stamp, Postmark, Bookmark, Ribbon, FriendCard, Sparkline, RingChart, MessageCard, ScanFrame,
});
