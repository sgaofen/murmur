// Murmur v3 — 3D Relationship Graph + Side Panel + View Switcher
// Globals: GraphView, GraphSidePanel, ViewSwitcherMenu, ConcentricView, TimeOrbitView,
//          buildGraphData

// ─── Data model ──────────────────────────────────────────
// Build ~120 nodes across 5 clusters with realistic distributions.
function buildGraphData() {
  const clusters = [
    { id:'family',  label:'家',       cx:-180, cy:-110, cz: 50,  color:'#FF6B47', n:8,  tier:'A' },
    { id:'college', label:'大学室友', cx: 200, cy:-130, cz:-30,  color:'#E8B57A', n:18, tier:'B' },
    { id:'work',    label:'前同事',   cx: 220, cy: 130, cz: 80,  color:'#5A7A99', n:32, tier:'C' },
    { id:'mihoyo',  label:'米哈游游戏群', cx:-200, cy: 140, cz:-60,  color:'#8AA48F', n:24, tier:'C' },
    { id:'old',     label:'旧同学',   cx: -50, cy: 230, cz: 30,  color:'#C45A3F', n:14, tier:'D' },
  ];
  const tierColors = { A:'#FF6B47', B:'#E8B57A', C:'#5A7A99', D:'#9E9583', E:'#C8BFAB' };
  const namesPool = [
    'kevin','Ashleyyy','🍓','whoO.O','+double','momo','xiao_chu','jpeg','7','little.k',
    'rin','Ada','Yuki','Lucia','baozi','曦','蓝','哈哈哈','Tom','Mira','peach','Owen',
    'Yumi','Eve','crow','jolin','蓝鲸','九','糖','noodle','olive','喵呜','Zoe','vincent',
    'Iris','Nori','plum','闷','sora','glow','kai','Yvonne','麦麦','黎','jjj','米','洛',
    'Amber','sasha','Rey','dust','Peony','linc','huan','Nico','rho','Wing','Theo','iso',
    '大刘','小C','二十一','vv','jet','Mio','toby','poppy','silv','Ren','哈','niko','quill',
    'Lex','Emm','beau','wren','古','aza','tor','vera','tex','jio','phi','rey','meg','quin',
    'Ines','tia','jam','noa','axel','sage','clay','arlo','wei','liu','peony','zee','rho2','iv',
    'mar','jun','win','elv','ona','tess','flo','jea','sun','iv2','arl','ral','col','dare','ash2',
    'kim','noo','fi','qa','val','xan','yul','zar','aro','beck','clo','dee','eim'
  ];
  let nameCursor = 0;
  const nodes = [];
  const edges = [];

  // self in center
  nodes.push({
    id:'self', name:'你', isSelf:true, tier:'self',
    cluster:null, color:'#FFE6CF', size:18,
    x:0, y:0, z:0, msgs:99999, longevity:8,
  });

  clusters.forEach(c => {
    for (let i=0; i<c.n; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = 60 + Math.random() * 70;
      // bias toward each cluster center using gaussian-ish offset
      const x = c.cx + Math.cos(angle) * r * (0.4 + Math.random()*0.6);
      const y = c.cy + Math.sin(angle) * r * (0.4 + Math.random()*0.6);
      const z = c.cz + (Math.random() - 0.5) * 120;
      const tier = Math.random() < 0.18 && c.tier!=='D' ? prevTier(c.tier) :
                   Math.random() < 0.25 ? nextTier(c.tier) : c.tier;
      const msgs = tier==='A' ? 2000 + Math.random()*3000 :
                   tier==='B' ? 600 + Math.random()*1500 :
                   tier==='C' ? 80  + Math.random()*500 :
                   tier==='D' ? 20  + Math.random()*100 : 5 + Math.random()*30;
      const size = 5 + Math.sqrt(msgs)/9;
      const name = namesPool[nameCursor++ % namesPool.length];
      nodes.push({
        id:`${c.id}_${i}`, name, tier,
        cluster:c.id, color:tierColors[tier], size,
        x, y, z, msgs:Math.round(msgs),
        longevity: 1 + Math.random()*7,
      });
    }
  });

  // 23 isolates (private only, far out, dashed line)
  for (let i=0; i<23; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r = 320 + Math.random() * 80;
    nodes.push({
      id:`iso_${i}`, name: namesPool[nameCursor++ % namesPool.length], tier:'E',
      cluster:null, color:tierColors.E, size: 3 + Math.random()*2,
      x: Math.cos(angle)*r, y: Math.sin(angle)*r, z: (Math.random()-0.5)*40,
      msgs: 5+Math.random()*40, longevity: 0.5+Math.random()*3, isolated:true,
    });
  }

  // bridges: 2 nodes that connect 2 clusters — promote them
  const bridges = ['college_3', 'work_5'];
  bridges.forEach(id => {
    const n = nodes.find(x => x.id===id);
    if (n) { n.bridge = true; n.size = Math.max(n.size, 11); }
  });

  // ─── EDGES ────────────────────────────────────────────
  // Multiple edge types reflect that the network is much more than self-spokes:
  //
  //   private    self ↔ friend (you DM them directly)
  //   co_group   friend ↔ friend (same WeChat group, weak default link)
  //   co_active  friend ↔ friend (they actively @ / reply each other in groups)
  //   mention    friend ↔ friend (they came up in YOUR private chats with each other —
  //                               e.g. you and kevin talked about Ashley 12 times)
  //   dm_inferred friend ↔ friend (cross-references suggest they DM directly without you)
  //   close_pair friend ↔ friend (very strong tie — best friends among your friends)

  // private edges: self → everyone
  nodes.forEach(n => {
    if (n.isSelf) return;
    edges.push({
      source:'self', target:n.id, type:'private',
      weight: Math.min(1, Math.sqrt(n.msgs)/50),
      dashed: !!n.isolated,
      meta:{ msgs:n.msgs },
    });
  });

  // helper to test cluster
  const inSameCluster = (a, b) => a.cluster && a.cluster === b.cluster;
  const distance = (a, b) => Math.hypot(a.x-b.x, a.y-b.y, (a.z-b.z)*0.5);

  // co_group: dense within each cluster
  clusters.forEach(c => {
    const members = nodes.filter(n => n.cluster===c.id);
    members.forEach((a, i) => {
      members.slice(i+1).forEach(b => {
        if (Math.random() < 0.32) {
          edges.push({
            source:a.id, target:b.id, type:'co_group',
            weight: 0.18 + Math.random()*0.35,
            meta:{ groups:[c.label], coMsgs: Math.round(20+Math.random()*200) },
          });
        }
      });
    });
  });

  // co_active: ~1/4 of co_group pairs are highly active together
  const coGroupEdges = edges.filter(e => e.type==='co_group');
  coGroupEdges.forEach(e => {
    if (Math.random() < 0.22) {
      edges.push({
        source: e.source, target: e.target, type: 'co_active',
        weight: 0.5 + Math.random()*0.5,
        meta:{ ats: Math.round(8+Math.random()*60), coMsgs: Math.round(80+Math.random()*400) },
      });
    }
  });

  // mention: pairs that you've discussed with each other.
  // Pick semi-random friend pairs across clusters; weight stronger for tier A/B friends.
  const friendNodes = nodes.filter(n => !n.isSelf && !n.isolated);
  const tierWeight = { A:1, B:0.7, C:0.35, D:0.1, E:0.05, self:0 };
  for (let attempts=0; attempts<480; attempts++) {
    const a = friendNodes[Math.floor(Math.random()*friendNodes.length)];
    const b = friendNodes[Math.floor(Math.random()*friendNodes.length)];
    if (a.id===b.id) continue;
    const p = (tierWeight[a.tier]||0) * (tierWeight[b.tier]||0) * 0.9;
    if (Math.random() > p) continue;
    edges.push({
      source:a.id, target:b.id, type:'mention',
      weight: 0.25 + Math.random()*0.45,
      meta:{ mentions: Math.round(3+Math.random()*30) },
    });
  }

  // dm_inferred: friends that likely DM each other (not via you).
  // Mostly within cluster, rarer cross-cluster — high weight when they do.
  for (let attempts=0; attempts<260; attempts++) {
    const a = friendNodes[Math.floor(Math.random()*friendNodes.length)];
    const b = friendNodes[Math.floor(Math.random()*friendNodes.length)];
    if (a.id===b.id) continue;
    const same = inSameCluster(a,b);
    const baseP = same ? 0.18 : 0.04;
    const p = baseP * (tierWeight[a.tier]||0) * (tierWeight[b.tier]||0) * 4;
    if (Math.random() > p) continue;
    edges.push({
      source:a.id, target:b.id, type:'dm_inferred',
      weight: 0.4 + Math.random()*0.5,
      meta:{ confidence: Math.round(60+Math.random()*40) },
    });
  }

  // close_pair: 14 designated best-friend friend-friend pairs (drawn last, on top)
  const closePairs = [
    ['college_0','college_4'], ['college_2','college_8'], ['college_3','mihoyo_2'],
    ['mihoyo_5','mihoyo_11'],   ['mihoyo_3','mihoyo_8'],
    ['work_2','work_15'],       ['work_5','work_22'],     ['work_5','old_3'],
    ['family_1','family_4'],    ['family_2','family_5'],
    ['old_1','old_7'],          ['old_4','old_11'],
    ['college_6','old_2'],      ['mihoyo_18','college_10'],
  ];
  closePairs.forEach(([a,b]) => {
    if (nodes.find(n=>n.id===a) && nodes.find(n=>n.id===b)) {
      edges.push({
        source:a, target:b, type:'close_pair',
        weight: 0.85,
        meta:{ note:'互为挚友' },
      });
    }
  });

  // bridge edges: bridges connect their cluster to others
  edges.push({ source:'college_3', target:'mihoyo_2', type:'co_group', weight:0.55 });
  edges.push({ source:'college_3', target:'work_8',   type:'mention',  weight:0.6, meta:{ mentions:18 } });
  edges.push({ source:'work_5',    target:'old_3',    type:'co_group', weight:0.5 });
  edges.push({ source:'work_5',    target:'old_7',    type:'mention',  weight:0.55, meta:{ mentions:14 } });

  return {
    nodes, edges, clusters,
    stats:{
      people: nodes.length,
      edges: edges.length,
      bridges: bridges.length,
      isolates: 23,
      clusters: clusters.length,
      ffEdges: edges.filter(e => e.source!=='self' && e.target!=='self').length,
    },
  };

  function prevTier(t){ return ({B:'A',C:'B',D:'C',E:'D'})[t] || t; }
  function nextTier(t){ return ({A:'B',B:'C',C:'D',D:'E'})[t] || t; }
}

// project 3D point to 2D with slow rotation; returns {x, y, depth (0..1, 1=closest)}
function project(p, rotY, w, h) {
  const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
  const x1 = p.x * cosY - p.z * sinY;
  const z1 = p.x * sinY + p.z * cosY;
  // perspective
  const f = 800;
  const scale = f / (f + z1);
  return {
    x: w/2 + x1 * scale,
    y: h/2 + p.y * scale,
    depth: scale, // smaller scale = farther; we use scale itself as depth signal
  };
}

// ─── Main GraphView ────────────────────────────────────────
function GraphView({ dark=false, showSelfPing=true, autoRotate=true, height=820 }) {
  const dataRef = React.useRef(null);
  if (!dataRef.current) dataRef.current = buildGraphData();
  const data = dataRef.current;

  const [rot, setRot] = React.useState(0);
  const [hover, setHover] = React.useState(null); // node id
  const [selected, setSelected] = React.useState('college_0'); // kevin

  React.useEffect(() => {
    if (!autoRotate) return;
    let raf;
    const tick = (t) => {
      setRot(t * 0.0001);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [autoRotate]);

  const W = 1240, H = height;
  // Project all nodes
  const projNodes = data.nodes.map(n => ({ ...n, proj: project(n, rot, W, H) }));
  const projById = Object.fromEntries(projNodes.map(n => [n.id, n]));
  // Sort by depth so far ones draw first
  const sortedNodes = [...projNodes].sort((a,b) => a.proj.depth - b.proj.depth);

  const selNode = projById[selected];
  const neighbors = new Set();
  if (selected) {
    data.edges.forEach(e => {
      if (e.source===selected) neighbors.add(e.target);
      if (e.target===selected) neighbors.add(e.source);
    });
  }

  return (
    <div style={{
      position:'relative', width:'100%', height:'100%',
      background: dark
        ? 'radial-gradient(ellipse at 50% 40%, #1B2548 0%, #0B0F22 70%, #050714 100%)'
        : 'linear-gradient(180deg, var(--et-bg) 0%, #EFE5D2 100%)',
      overflow:'hidden',
    }}>
      {/* starfield (dark only) */}
      {dark && <Starfield/>}
      {/* nebulae */}
      {dark && (
        <>
          <div style={{ position:'absolute', left:'18%', top:'20%', width:340, height:340, borderRadius:'50%',
            background:'radial-gradient(circle, rgba(255,107,71,0.18), transparent 65%)', filter:'blur(20px)' }}/>
          <div style={{ position:'absolute', right:'12%', top:'55%', width:280, height:280, borderRadius:'50%',
            background:'radial-gradient(circle, rgba(232,181,122,0.14), transparent 65%)', filter:'blur(20px)' }}/>
        </>
      )}

      {/* top chrome */}
      <GraphChrome dark={dark}/>

      {/* SVG canvas */}
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position:'absolute', inset:0, width:'100%', height:'100%' }}>
        <defs>
          <radialGradient id="self-glow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#FFE6CF" stopOpacity="1"/>
            <stop offset="60%" stopColor="#FF6B47" stopOpacity="0.6"/>
            <stop offset="100%" stopColor="#FF6B47" stopOpacity="0"/>
          </radialGradient>
          <radialGradient id="sel-glow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#FF6B47" stopOpacity="0.5"/>
            <stop offset="100%" stopColor="#FF6B47" stopOpacity="0"/>
          </radialGradient>
          <filter id="soft-blur"><feGaussianBlur stdDeviation="0.7"/></filter>
        </defs>

        {/* cluster halos (drawn first) */}
        {data.clusters.map(c => {
          const center = project({ x:c.cx, y:c.cy, z:c.cz }, rot, W, H);
          const r = 80 + c.n * 2.2;
          return (
            <g key={c.id}>
              <circle cx={center.x} cy={center.y} r={r * center.depth}
                fill={c.color} opacity={dark ? 0.08 : 0.06}/>
              <circle cx={center.x} cy={center.y} r={r * center.depth}
                fill="none" stroke={c.color} strokeOpacity={dark ? 0.32 : 0.25} strokeWidth="0.5" strokeDasharray="3 4"/>
              <text x={center.x} y={center.y - r*center.depth - 6}
                fontFamily="var(--et-sans)" fontSize="10.5" fontWeight="600"
                letterSpacing="0.18em" textAnchor="middle"
                fill={dark ? 'rgba(244,236,218,0.55)' : 'rgba(26,43,74,0.55)'}>
                {c.label.toUpperCase()}
              </text>
            </g>
          );
        })}

        {/* edges — drawn in priority order so important friend-friend ties sit on top of self-spokes */}
        {(() => {
          const order = { private:0, co_group:1, mention:2, co_active:3, dm_inferred:4, close_pair:5 };
          const sorted = [...data.edges].sort((a,b) => (order[a.type]||0) - (order[b.type]||0));
          return sorted.map((e, i) => {
            const a = projById[e.source], b = projById[e.target];
            if (!a || !b) return null;
            const isPriv = e.type==='private';
            const isHighlight = selected && (e.source===selected || e.target===selected);
            const dimmed = selected && !isHighlight;
            const styleByType = {
              private:    { stroke:'#FF6B47',                 width: 1.2, opMul:0.5, dash:e.dashed ? '2 4':null },
              co_group:   { stroke: dark ? '#5A7A99':'#1A2B4A', width: 0.8, opMul:0.32, dash:'1 3' },
              co_active:  { stroke: dark ? '#8FA8C4':'#2C4670', width: 1.4, opMul:0.6, dash:null },
              mention:    { stroke: dark ? '#E8B57A':'#B98643', width: 1.0, opMul:0.5, dash:null },
              dm_inferred:{ stroke: dark ? '#FF8867':'#D85A37', width: 1.1, opMul:0.55, dash:'5 4' },
              close_pair: { stroke: dark ? '#FF6B47':'#E0532E', width: 2.4, opMul:0.95, dash:null },
            };
            const s = styleByType[e.type] || styleByType.co_group;
            const baseOp = e.weight * s.opMul + (isPriv ? 0.05 : 0.04);
            const op = dimmed ? baseOp * 0.16 : (isHighlight ? Math.min(1, baseOp * 2.3) : baseOp);
            // Self spokes: straight line. Friend-friend: subtle quadratic curve so the network reads as fabric, not a star.
            const isSelfEdge = e.source === 'self' || e.target === 'self';
            if (isSelfEdge) {
              return (
                <line key={i}
                  x1={a.proj.x} y1={a.proj.y} x2={b.proj.x} y2={b.proj.y}
                  stroke={s.stroke} strokeOpacity={op} strokeWidth={s.width * Math.max(0.4, e.weight)}
                  strokeDasharray={s.dash || 'none'}/>
              );
            }
            // curve control point — perpendicular bow outward from canvas center
            const mx = (a.proj.x + b.proj.x) / 2;
            const my = (a.proj.y + b.proj.y) / 2;
            const dx = b.proj.x - a.proj.x;
            const dy = b.proj.y - a.proj.y;
            const len = Math.hypot(dx, dy) || 1;
            // bow magnitude: small for short edges, modest for long
            const bow = Math.min(28, len * 0.12);
            // perpendicular direction, then bias outward from canvas center
            let nx = -dy / len, ny = dx / len;
            const cxFromMid = mx - W/2, cyFromMid = my - H/2;
            if (nx*cxFromMid + ny*cyFromMid < 0) { nx = -nx; ny = -ny; }
            const cx = mx + nx * bow;
            const cy = my + ny * bow;
            return (
              <path key={i}
                d={`M${a.proj.x},${a.proj.y} Q${cx},${cy} ${b.proj.x},${b.proj.y}`}
                stroke={s.stroke} strokeOpacity={op} strokeWidth={s.width * Math.max(0.5, e.weight)}
                strokeDasharray={s.dash || 'none'}
                fill="none"
                strokeLinecap="round"/>
            );
          });
        })()}

        {/* self ping ripples */}
        {showSelfPing && (
          <g>
            {[0, 1, 2].map(i => {
              const offset = (Date.now()/1500 + i*0.33) % 1;
              return (
                <circle key={i}
                  cx={W/2} cy={H/2} r={20 + offset*220}
                  fill="none" stroke="#FF6B47"
                  strokeOpacity={(1 - offset) * 0.35}
                  strokeWidth="1"/>
              );
            })}
          </g>
        )}

        {/* nodes */}
        {sortedNodes.map(n => {
          const r = n.size * n.proj.depth;
          const isSel = selected === n.id;
          const isHov = hover === n.id;
          const isNeighbor = neighbors.has(n.id);
          const dim = selected && !isSel && !isNeighbor && !n.isSelf;
          const op = dim ? 0.32 : 1;
          return (
            <g key={n.id}
               style={{ cursor:'pointer' }}
               onMouseEnter={()=>setHover(n.id)}
               onMouseLeave={()=>setHover(null)}
               onClick={()=>setSelected(n.id)}
               opacity={op}>
              {n.isSelf && (
                <circle cx={n.proj.x} cy={n.proj.y} r={r*4}
                  fill="url(#self-glow)" opacity="0.7"/>
              )}
              {isSel && !n.isSelf && (
                <circle cx={n.proj.x} cy={n.proj.y} r={r*3.2}
                  fill="url(#sel-glow)"/>
              )}
              {n.bridge && (
                <circle cx={n.proj.x} cy={n.proj.y} r={r+2}
                  fill="none" stroke="#E8B57A" strokeWidth="1.4" opacity="0.85"/>
              )}
              <circle cx={n.proj.x} cy={n.proj.y} r={r}
                fill={n.color}
                stroke={dark ? 'rgba(20,24,42,0.6)' : 'rgba(255,255,255,0.7)'}
                strokeWidth={n.proj.depth * 0.6}
              />
              {/* highlight on top */}
              <circle cx={n.proj.x - r*0.3} cy={n.proj.y - r*0.3} r={r*0.35}
                fill={dark ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.45)'}/>
              {/* label for self + selected + hovered + bridges + tier-A */}
              {(n.isSelf || isSel || isHov || n.bridge || (n.tier==='A' && r > 5)) && (
                <text x={n.proj.x} y={n.proj.y + r + 12}
                  textAnchor="middle"
                  fontFamily={n.isSelf || isSel ? 'var(--et-serif)' : 'var(--et-sans)'}
                  fontSize={n.isSelf ? 14 : isSel ? 13 : 11}
                  fontWeight={n.isSelf || isSel ? 600 : 500}
                  fill={dark ? '#F4ECDA' : '#1A2B4A'}
                  style={{ pointerEvents:'none' }}>
                  {n.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* hover tooltip */}
      {hover && projById[hover] && !selected && (
        <NodeTooltip node={projById[hover]} dark={dark}/>
      )}

      {/* legend */}
      <Legend dark={dark}/>

      {/* overview panel */}
      <OverviewPanel stats={data.stats} dark={dark}/>

      {/* breathing hint */}
      <div style={{
        position:'absolute', left:24, top:74, display:'flex', alignItems:'center', gap:8,
        color: dark ? 'rgba(244,236,218,0.6)' : 'rgba(26,43,74,0.55)',
        fontFamily:'var(--et-sans)', fontSize:11,
      }}>
        <span style={{
          width:6, height:6, borderRadius:'50%',
          background:'#FF6B47',
          animation:'mr-pulse 2.4s ease-in-out infinite',
        }}/>
        网络在缓慢呼吸 · 拖动可旋转
      </div>
      <style>{`@keyframes mr-pulse{0%,100%{opacity:.4;transform:scale(1)}50%{opacity:1;transform:scale(1.6)}}`}</style>
    </div>
  );
}

function Starfield() {
  const stars = React.useMemo(() => {
    const arr = [];
    for (let i=0; i<140; i++) {
      arr.push({
        x: Math.random()*100, y: Math.random()*100,
        s: Math.random() < 0.85 ? 1 : 1.6,
        o: 0.3 + Math.random()*0.7,
        d: Math.random()*4,
      });
    }
    return arr;
  }, []);
  return (
    <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none' }}>
      {stars.map((s, i) => (
        <circle key={i} cx={`${s.x}%`} cy={`${s.y}%`} r={s.s}
          fill="white" opacity={s.o}>
          <animate attributeName="opacity" values={`${s.o};${s.o*0.3};${s.o}`} dur={`${3+s.d}s`} repeatCount="indefinite"/>
        </circle>
      ))}
    </svg>
  );
}

function GraphChrome({ dark }) {
  const tColor = dark ? '#F4ECDA' : '#1A2B4A';
  const muteColor = dark ? 'rgba(244,236,218,0.65)' : 'rgba(26,43,74,0.65)';
  return (
    <div style={{
      position:'absolute', left:0, right:0, top:0, zIndex:5,
      padding:'18px 28px', display:'flex', alignItems:'center', justifyContent:'space-between',
      background: dark ? 'linear-gradient(180deg, rgba(11,15,34,0.65), transparent)'
                       : 'linear-gradient(180deg, rgba(247,241,230,0.85), transparent)',
    }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:14 }}>
        <span style={{ fontFamily:'var(--et-serif)', fontSize:18, fontWeight:600, color:tColor }}>
          Murmur · 关系网络
        </span>
        <span style={{ fontFamily:'var(--et-sans)', fontSize:11, color:muteColor, letterSpacing:'0.12em' }}>
          一张可旋转的社交星图
        </span>
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
        <SearchBar dark={dark}/>
        <ChromeBtn dark={dark} icon="◇" label="视图"/>
        <ChromeBtn dark={dark} icon="⏚" label="布局"/>
        <ChromeBtn dark={dark} icon={dark ? '☼' : '☾'} label={dark ? '切到亮' : '切到暗'}/>
      </div>
    </div>
  );
}
function SearchBar({ dark }) {
  const bg = dark ? 'rgba(20,24,42,0.6)' : 'rgba(251,246,238,0.8)';
  const border = dark ? 'rgba(244,236,218,0.18)' : 'rgba(26,43,74,0.18)';
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:8,
      padding:'7px 12px', borderRadius:999,
      background:bg, border:`0.5px solid ${border}`,
      backdropFilter:'blur(8px)', minWidth:240,
    }}>
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke={dark ? '#A39B86' : '#6F6A5C'} strokeWidth="1.4">
        <circle cx="5.5" cy="5.5" r="4"/><path d="M8.5 8.5l3 3" strokeLinecap="round"/>
      </svg>
      <input placeholder="按名字、群聊、关系层级查找…" style={{
        all:'unset', flex:1, fontSize:12,
        color: dark ? '#F4ECDA' : '#1A2B4A',
        fontFamily:'var(--et-sans)',
      }}/>
      <span style={{
        padding:'1px 6px', borderRadius:4, fontSize:10,
        fontFamily:'var(--et-mono)', color: dark ? '#A39B86' : '#6F6A5C',
        border:`0.5px solid ${border}`,
      }}>⌘K</span>
    </div>
  );
}
function ChromeBtn({ dark, icon, label }) {
  return (
    <button style={{
      all:'unset', cursor:'pointer',
      padding:'7px 12px', borderRadius:999,
      display:'inline-flex', alignItems:'center', gap:6,
      fontFamily:'var(--et-sans)', fontSize:12, fontWeight:500,
      background: dark ? 'rgba(20,24,42,0.6)' : 'rgba(251,246,238,0.8)',
      border:`0.5px solid ${dark ? 'rgba(244,236,218,0.18)' : 'rgba(26,43,74,0.18)'}`,
      color: dark ? '#F4ECDA' : '#1A2B4A',
      backdropFilter:'blur(8px)',
    }}>
      <span style={{ opacity:0.7 }}>{icon}</span>{label}
    </button>
  );
}

function Legend({ dark }) {
  const tiers = [
    { color:'#FF6B47', label:'A · 灵魂朋友' },
    { color:'#E8B57A', label:'B · 常聊朋友' },
    { color:'#5A7A99', label:'C · 一般联系' },
    { color:'#9E9583', label:'D · 弱关系' },
    { color:'#C8BFAB', label:'E · 沉默 / 孤岛' },
  ];
  const bg = dark ? 'rgba(20,24,42,0.7)' : 'rgba(251,246,238,0.85)';
  const border = dark ? 'rgba(244,236,218,0.14)' : 'rgba(26,43,74,0.12)';
  return (
    <div style={{
      position:'absolute', left:24, bottom:24,
      padding:'14px 16px', borderRadius:14,
      background:bg, border:`0.5px solid ${border}`,
      backdropFilter:'blur(12px)',
    }}>
      <div style={{ fontFamily:'var(--et-sans)', fontSize:10, letterSpacing:'0.18em',
        color: dark ? 'rgba(244,236,218,0.55)' : 'rgba(26,43,74,0.55)', textTransform:'uppercase' }}>
        关系层级
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:6, marginTop:8 }}>
        {tiers.map(t => (
          <div key={t.label} style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ width:10, height:10, borderRadius:'50%', background:t.color, boxShadow:'inset 0 0 2px rgba(255,255,255,0.5)' }}/>
            <span style={{ fontFamily:'var(--et-sans)', fontSize:11, color: dark ? '#F4ECDA' : '#1A2B4A' }}>{t.label}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop:12, paddingTop:10, borderTop:`0.5px dashed ${border}` }}>
        <div style={{ fontFamily:'var(--et-sans)', fontSize:10, letterSpacing:'0.18em',
          color: dark ? 'rgba(244,236,218,0.5)' : 'rgba(26,43,74,0.5)', textTransform:'uppercase', marginBottom:8 }}>
          关系类型
        </div>
        {[
          { stroke:'#FF6B47',                 dash:null,   width:2.2,  label:'你 ↔ 他（私聊）' },
          { stroke: dark?'#FF6B47':'#E0532E', dash:null,   width:3,    label:'挚友对（朋友间最强）' },
          { stroke: dark?'#8FA8C4':'#2C4670', dash:null,   width:1.8,  label:'群里互动密切' },
          { stroke: dark?'#E8B57A':'#B98643', dash:null,   width:1.4,  label:'你和他们聊到过对方' },
          { stroke: dark?'#FF8867':'#D85A37', dash:'4 3',  width:1.4,  label:'推测他俩私下也聊（虚线）' },
          { stroke: dark?'#5A7A99':'#1A2B4A', dash:'1 3',  width:1,    label:'共群（点状）' },
        ].map((e, i) => (
          <div key={i} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:5 }}>
            <svg width="22" height="6" style={{ flexShrink:0 }}>
              <line x1="0" y1="3" x2="22" y2="3"
                stroke={e.stroke} strokeWidth={e.width}
                strokeDasharray={e.dash || 'none'} strokeLinecap="round"/>
            </svg>
            <span style={{ fontFamily:'var(--et-sans)', fontSize:11, color: dark ? '#F4ECDA' : '#1A2B4A' }}>{e.label}</span>
          </div>
        ))}
        <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:8 }}>
          <span style={{ display:'inline-block', width:10, height:10, borderRadius:'50%', border:'1.4px solid #E8B57A', boxSizing:'border-box' }}/>
          <span style={{ fontFamily:'var(--et-sans)', fontSize:11, color: dark ? '#F4ECDA' : '#1A2B4A' }}>桥梁人物（金边）</span>
        </div>
      </div>
    </div>
  );
}

function OverviewPanel({ stats, dark }) {
  const bg = dark ? 'rgba(20,24,42,0.7)' : 'rgba(251,246,238,0.85)';
  const border = dark ? 'rgba(244,236,218,0.14)' : 'rgba(26,43,74,0.12)';
  const tColor = dark ? '#F4ECDA' : '#1A2B4A';
  const mute = dark ? 'rgba(244,236,218,0.6)' : 'rgba(26,43,74,0.6)';
  return (
    <div style={{
      position:'absolute', right:24, bottom:24,
      width:300, padding:'18px 20px',
      background:bg, border:`0.5px solid ${border}`,
      backdropFilter:'blur(12px)', borderRadius:14,
    }}>
      <div style={{ fontFamily:'var(--et-sans)', fontSize:10, letterSpacing:'0.18em',
        color: mute, textTransform:'uppercase' }}>关于这张图</div>
      <div style={{ display:'flex', alignItems:'baseline', gap:8, marginTop:8 }}>
        <span style={{ width:8, height:8, borderRadius:'50%', background:'#FFE6CF', boxShadow:'0 0 8px #FF6B47' }}/>
        <span style={{ fontFamily:'var(--et-serif)', fontSize:14, fontWeight:600, color:tColor }}>
          你处在中心
        </span>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:14 }}>
        <Stat dark={dark} num={stats.people} label="个节点"/>
        <Stat dark={dark} num={stats.ffEdges} label="朋友间互连"/>
        <Stat dark={dark} num={stats.clusters} label="个核心圈"/>
        <Stat dark={dark} num={stats.bridges} label="个桥梁人物"/>
      </div>
      <div style={{ marginTop:14, paddingTop:12, borderTop:`0.5px dashed ${border}`,
        fontFamily:'var(--et-serif)', fontSize:13, lineHeight:1.6, color:tColor, fontStyle:'italic' }}>
        "你不在场时，他们也在彼此身上留下痕迹——{stats.ffEdges} 条不经过你的连线。"
      </div>
    </div>
  );
}
function Stat({ dark, num, label }) {
  return (
    <div>
      <div style={{ fontFamily:'var(--et-serif)', fontSize:24, fontWeight:600, color: dark ? '#F4ECDA' : '#1A2B4A',
        fontVariantNumeric:'tabular-nums', lineHeight:1 }}>{num}</div>
      <div style={{ fontFamily:'var(--et-sans)', fontSize:11, color: dark ? 'rgba(244,236,218,0.6)' : 'rgba(26,43,74,0.6)', marginTop:2 }}>{label}</div>
    </div>
  );
}

function NodeTooltip({ node, dark }) {
  if (!node || !node.proj) return null;
  return (
    <div style={{
      position:'absolute',
      left: node.proj.x + 12, top: node.proj.y - 30,
      padding:'8px 12px', borderRadius:10,
      background: dark ? 'rgba(20,24,42,0.92)' : 'rgba(26,43,74,0.92)',
      color:'#F4ECDA',
      fontFamily:'var(--et-sans)', fontSize:11,
      boxShadow:'0 8px 24px rgba(0,0,0,0.3)',
      pointerEvents:'none',
    }}>
      <div style={{ fontWeight:600, fontSize:12.5 }}>{node.name}</div>
      <div style={{ opacity:0.75, marginTop:2 }}>
        {node.tier==='self' ? '是你' : `${node.tier} 级 · ${node.msgs} 条消息`}
      </div>
    </div>
  );
}

// ─── Side Panel ────────────────────────────────────────────
const PERSONAS = {
  kevin: {
    name:'kevin', tier:'B', tierLabel:'常聊朋友', avatarColor:'#FF6B47',
    privateMsgs: 3088, groupMsgs: 847,
    privateNote: '私聊里更松弛、幽默，会聊脆弱',
    groupNote:   '群里更稳重、主动维护气氛',
    sharedGroups: [
      { name:'米哈游游戏群', members:'你俩 + 5 人', tag:'游戏' },
      { name:'旧同学群',     members:'你俩 + 12 人', tag:'同学' },
    ],
    mutualFriends: ['Ashleyyy','whoO.O','+double','momo'],
    signals: [
      { label:'持续年限',     value:'1.2 年' },
      { label:'线下证据',     value:'97 条' },
      { label:'双方脆弱表达', value:'23 次' },
      { label:'通话',         value:'3 次' },
    ],
  },
  ashley: {
    name:'Ashleyyy', tier:'A', tierLabel:'灵魂朋友', avatarColor:'#E8B57A',
    privateMsgs: 6420, groupMsgs: 312,
    privateNote: '深夜 BFF·语音轰炸·无主题脉络',
    groupNote:   '群里几乎不发言，靠你转述',
    sharedGroups: [
      { name:'旧同学群',  members:'你俩 + 12 人', tag:'同学' },
    ],
    mutualFriends: ['kevin','+double'],
    signals: [
      { label:'持续年限',     value:'5.8 年' },
      { label:'线下证据',     value:'214 条' },
      { label:'双方脆弱表达', value:'89 次' },
      { label:'通话',         value:'27 次' },
    ],
  },
};

function GraphSidePanel({ personaId='kevin' }) {
  const [pid, setPid] = React.useState(personaId);
  const p = PERSONAS[pid];
  const total = p.privateMsgs + p.groupMsgs;
  const privPct = (p.privateMsgs / total) * 100;

  return (
    <div style={{
      position:'absolute', right:0, top:0, bottom:0, width:480,
      background:'var(--et-paper)', borderLeft:'0.5px solid var(--et-line-2)',
      boxShadow:'-12px 0 32px rgba(20,24,42,0.18)',
      display:'flex', flexDirection:'column',
      zIndex:20,
    }}>
      {/* header */}
      <div style={{ padding:'18px 24px 14px', display:'flex', alignItems:'center', justifyContent:'space-between',
        borderBottom:'0.5px solid var(--et-line)' }}>
        <button style={{ all:'unset', cursor:'pointer', display:'flex', alignItems:'center', gap:6,
          fontSize:12, color:'var(--et-mute)' }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M9 2l-4 4 4 4" strokeLinecap="round"/>
          </svg>
          收起
        </button>
        {/* persona toggle */}
        <div style={{ display:'flex', gap:4, padding:3, borderRadius:999, background:'rgba(26,43,74,0.06)' }}>
          {Object.entries(PERSONAS).map(([k, v]) => (
            <button key={k} onClick={()=>setPid(k)} style={{
              all:'unset', cursor:'pointer', padding:'4px 12px', borderRadius:999,
              fontSize:11, fontWeight:600,
              background: pid===k ? 'var(--et-paper)' : 'transparent',
              color: pid===k ? 'var(--et-ink)' : 'var(--et-mute)',
              boxShadow: pid===k ? '0 1px 4px rgba(26,43,74,0.08)' : 'none',
            }}>{v.name}</button>
          ))}
        </div>
      </div>

      {/* scroll content */}
      <div style={{ flex:1, overflow:'auto', padding:'22px 24px 24px' }}>
        {/* identity */}
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <div style={{
            width:64, height:64, borderRadius:'50%',
            background:`radial-gradient(circle at 30% 30%, ${p.avatarColor}, ${p.avatarColor}99)`,
            border:'0.5px solid rgba(26,43,74,0.18)',
            display:'flex', alignItems:'center', justifyContent:'center',
            color:'#fff', fontFamily:'var(--et-serif)', fontSize:24, fontWeight:600,
            boxShadow:'inset 0 4px 8px rgba(255,255,255,0.3), 0 4px 12px rgba(26,43,74,0.12)',
          }}>{p.name.slice(0,1).toUpperCase()}</div>
          <div>
            <div style={{ fontFamily:'var(--et-serif)', fontSize:24, fontWeight:600, color:'var(--et-ink)' }}>{p.name}</div>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:4 }}>
              <span style={{
                padding:'2px 10px', borderRadius:999,
                background:'var(--et-orange-soft)', color:'var(--et-orange-2)',
                fontSize:11, fontWeight:600, letterSpacing:'0.04em',
                border:'0.5px solid rgba(224,83,46,0.18)',
              }}>{p.tier} 级</span>
              <span style={{ fontSize:12, color:'var(--et-mute)' }}>{p.tierLabel}</span>
            </div>
          </div>
        </div>

        {/* cross-scene profile */}
        <Section title="跨场景画像" eyebrow="同一人，两面"/>
        <div style={{
          padding:'16px 18px', borderRadius:12,
          background:'rgba(26,43,74,0.04)', border:'0.5px solid var(--et-line)',
        }}>
          <CrossScene label="私聊" value={p.privateMsgs} pct={privPct} color="#FF6B47" note={p.privateNote}/>
          <div style={{ height:10 }}/>
          <CrossScene label="群聊" value={p.groupMsgs} pct={100-privPct} color="#5A7A99" note={p.groupNote}/>
        </div>
        <p style={{
          marginTop:12, padding:'10px 14px',
          background:'var(--et-orange-soft)', borderLeft:'2px solid var(--et-orange)',
          fontFamily:'var(--et-serif)', fontSize:13, fontStyle:'italic',
          color:'var(--et-ink-soft)', lineHeight:1.55, borderRadius:'0 8px 8px 0',
        }}>
          *  在群里他更稳重，私聊里更松弛——这是‘双面熟人’的典型信号。
        </p>

        {/* shared groups */}
        <Section title={`共同社交圈（${p.sharedGroups.length}）`}/>
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {p.sharedGroups.map(g => (
            <div key={g.name} style={{
              padding:'10px 14px', borderRadius:10,
              border:'0.5px solid var(--et-line-2)', background:'var(--et-paper)',
              display:'flex', alignItems:'center', gap:10,
            }}>
              <div style={{
                width:30, height:30, borderRadius:7,
                background:'var(--et-paper-2)', border:'0.5px solid var(--et-line)',
                display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:1, padding:3,
              }}>
                {Array.from({length:6}).map((_,i)=>(
                  <span key={i} style={{ background:`hsl(${i*40+30}, 50%, 70%)`, borderRadius:1 }}/>
                ))}
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, fontWeight:600, color:'var(--et-ink)' }}>{g.name}</div>
                <div style={{ fontSize:11, color:'var(--et-mute)' }}>{g.members}</div>
              </div>
              <span className="et-chip ink" style={{ fontSize:10 }}>{g.tag}</span>
            </div>
          ))}
        </div>

        {/* mutual */}
        <Section title={`共同朋友（${p.mutualFriends.length}）`}/>
        <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
          {p.mutualFriends.map((f, i) => (
            <div key={f} style={{
              display:'flex', alignItems:'center', gap:8,
              padding:'6px 12px 6px 6px', borderRadius:999,
              border:'0.5px solid var(--et-line-2)', background:'var(--et-paper)',
            }}>
              <span style={{
                width:22, height:22, borderRadius:'50%',
                background:`hsl(${i*60+30}, 60%, 65%)`,
                border:'0.5px solid rgba(26,43,74,0.2)',
              }}/>
              <span style={{ fontSize:12, fontWeight:500, color:'var(--et-ink)' }}>{f}</span>
            </div>
          ))}
        </div>

        {/* signals */}
        <Section title="关键信号"/>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          {p.signals.map(s => (
            <div key={s.label} style={{
              padding:'12px 14px', borderRadius:10,
              border:'0.5px solid var(--et-line)', background:'var(--et-paper)',
            }}>
              <div style={{ fontSize:11, color:'var(--et-mute)', letterSpacing:'0.06em' }}>{s.label}</div>
              <div className="et-num" style={{ fontFamily:'var(--et-serif)', fontSize:20, fontWeight:600, color:'var(--et-ink)', marginTop:4 }}>
                {s.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* footer actions */}
      <div style={{ padding:'14px 24px', borderTop:'0.5px solid var(--et-line)',
        display:'flex', gap:10, background:'rgba(26,43,74,0.02)' }}>
        <button style={{
          all:'unset', cursor:'pointer', flex:1, textAlign:'center',
          padding:'10px 0', borderRadius:10,
          background:'var(--et-paper)', border:'0.5px solid var(--et-line-2)',
          fontSize:12.5, fontWeight:600, color:'var(--et-ink)',
        }}>📓 完整关系档案</button>
        <button style={{
          all:'unset', cursor:'pointer', flex:1, textAlign:'center',
          padding:'10px 0', borderRadius:10,
          background:'var(--et-orange)', color:'#fff',
          fontSize:12.5, fontWeight:600,
          boxShadow:'0 4px 12px rgba(255,107,71,0.3)',
        }}>✦ 让 AI 分析</button>
      </div>
    </div>
  );
}

function Section({ title, eyebrow }) {
  return (
    <div style={{ marginTop:24, marginBottom:12 }}>
      {eyebrow && <div className="et-eyebrow" style={{ marginBottom:4 }}>{eyebrow}</div>}
      <div style={{ fontFamily:'var(--et-serif)', fontSize:16, fontWeight:600, color:'var(--et-ink)' }}>{title}</div>
    </div>
  );
}

function CrossScene({ label, value, pct, color, note }) {
  return (
    <div>
      <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:5 }}>
        <span style={{ fontSize:12, fontWeight:600, color:'var(--et-ink)' }}>{label}</span>
        <span className="et-num" style={{ fontFamily:'var(--et-serif)', fontSize:14, fontWeight:600, color:'var(--et-ink)' }}>
          {value.toLocaleString()} <span style={{ fontSize:11, color:'var(--et-mute)', fontWeight:400 }}>条</span>
        </span>
      </div>
      <div style={{ height:6, background:'rgba(26,43,74,0.08)', borderRadius:999, overflow:'hidden' }}>
        <div style={{ width:`${pct}%`, height:'100%', background:color, borderRadius:999 }}/>
      </div>
      <div style={{ fontSize:11, color:'var(--et-mute)', marginTop:5, fontStyle:'italic' }}>{note}</div>
    </div>
  );
}

// ─── View Switcher Menu ────────────────────────────────────
function ViewSwitcherMenu({ active='graph' }) {
  const views = [
    { id:'graph',     label:'关系网',   sub:'3D 力导向 · 默认',      thumb:<ThumbGraph/> },
    { id:'concentric',label:'同心圆',   sub:'按关系层级分层',         thumb:<ThumbConcentric/> },
    { id:'timeorbit', label:'时间轨道', sub:'X 轴=认识年份',          thumb:<ThumbOrbit/> },
    { id:'groups',    label:'群聊视角', sub:'节点变成群',             thumb:<ThumbGroups/> },
  ];
  return (
    <div style={{
      width:'100%', height:'100%', padding:'40px 50px',
      background:'var(--et-bg)', display:'flex', flexDirection:'column', gap:18,
    }}>
      <div>
        <div className="et-eyebrow">视图 · 同一张网，四种看法</div>
        <div className="et-h1" style={{ marginTop:6, color:'var(--et-ink)' }}>选一个角度</div>
        <div className="et-body" style={{ marginTop:6, color:'var(--et-mute)', maxWidth:640 }}>
          每种视图揭示不同的关系信号——力导向看圈层，同心圆看层级，时间轨道看历史，群聊视角看场景。
        </div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)', gap:14, flex:1 }}>
        {views.map(v => (
          <div key={v.id} style={{
            position:'relative', overflow:'hidden',
            background:'var(--et-paper)', borderRadius:16,
            border: v.id===active ? '1.5px solid var(--et-orange)' : '0.5px solid var(--et-line-2)',
            boxShadow: v.id===active ? '0 8px 24px rgba(255,107,71,0.18)' : 'var(--et-shadow-1)',
            cursor:'pointer', display:'flex', flexDirection:'column',
          }}>
            <div style={{ flex:1, background:'linear-gradient(180deg, var(--et-paper-2), var(--et-paper))', minHeight:0 }}>
              {v.thumb}
            </div>
            <div style={{ padding:'14px 16px', display:'flex', alignItems:'baseline', justifyContent:'space-between',
              borderTop:'0.5px solid var(--et-line)' }}>
              <div>
                <div style={{ fontFamily:'var(--et-serif)', fontSize:17, fontWeight:600, color:'var(--et-ink)' }}>{v.label}</div>
                <div className="et-meta" style={{ marginTop:2 }}>{v.sub}</div>
              </div>
              {v.id===active
                ? <span className="et-chip" style={{ fontSize:10 }}>当前视图</span>
                : <span style={{ fontSize:11, color:'var(--et-orange)', fontWeight:600 }}>切换 →</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// thumbnails
function ThumbGraph() {
  return (
    <svg viewBox="0 0 200 120" style={{ width:'100%', height:'100%' }}>
      <circle cx="100" cy="60" r="6" fill="#FFE6CF"/>
      {[[60,30],[140,28],[160,70],[40,80],[80,20],[130,90],[35,55],[170,45],[110,100]].map(([x,y],i) => (
        <g key={i}>
          <line x1="100" y1="60" x2={x} y2={y} stroke="#FF6B47" strokeWidth="0.4" opacity="0.5"/>
          <circle cx={x} cy={y} r={2.5 + Math.random()*1.5} fill={['#FF6B47','#E8B57A','#5A7A99','#8AA48F'][i%4]}/>
        </g>
      ))}
    </svg>
  );
}
function ThumbConcentric() {
  return (
    <svg viewBox="0 0 200 120" style={{ width:'100%', height:'100%' }}>
      {[15,30,45,55].map((r,i) => (
        <circle key={i} cx="100" cy="60" r={r} fill="none" stroke="#1A2B4A" strokeOpacity="0.18" strokeDasharray="2 3"/>
      ))}
      <circle cx="100" cy="60" r="6" fill="#FFE6CF"/>
      {[[88,55],[112,57],[100,46]].map(([x,y],i)=><circle key={i} cx={x} cy={y} r="2.5" fill="#FF6B47"/>)}
      {[[78,65],[125,66],[105,80],[92,42],[120,45]].map(([x,y],i)=><circle key={i} cx={x} cy={y} r="2" fill="#E8B57A"/>)}
      {[[70,80],[135,75],[140,40],[60,40],[105,95]].map(([x,y],i)=><circle key={i} cx={x} cy={y} r="1.6" fill="#5A7A99"/>)}
    </svg>
  );
}
function ThumbOrbit() {
  return (
    <svg viewBox="0 0 200 120" style={{ width:'100%', height:'100%' }}>
      <line x1="20" y1="100" x2="180" y2="100" stroke="#1A2B4A" strokeOpacity="0.4" strokeWidth="0.5"/>
      <line x1="30" y1="100" x2="30" y2="20" stroke="#1A2B4A" strokeOpacity="0.4" strokeWidth="0.5"/>
      {[[40,80,'#FF6B47'],[60,55,'#FF6B47'],[80,40,'#E8B57A'],[100,30,'#FF6B47'],[120,50,'#5A7A99'],[140,65,'#E8B57A'],[160,82,'#5A7A99']].map(([x,y,c],i)=>(
        <g key={i}>
          <line x1={x} y1="100" x2={x} y2={y} stroke={c} strokeWidth="0.4" opacity="0.4"/>
          <circle cx={x} cy={y} r="3" fill={c}/>
        </g>
      ))}
      <text x="100" y="115" fontSize="6" fill="#6F6A5C" textAnchor="middle" fontFamily="sans-serif">2018  2020  2022  2024  2026</text>
    </svg>
  );
}
function ThumbGroups() {
  return (
    <svg viewBox="0 0 200 120" style={{ width:'100%', height:'100%' }}>
      {[[60,40,'家',16,'#FF6B47'],[140,40,'室友',22,'#E8B57A'],[55,80,'同事',28,'#5A7A99'],[140,85,'同学',18,'#8AA48F']].map(([x,y,l,r,c],i)=>(
        <g key={i}>
          <circle cx={x} cy={y} r={r} fill={c} opacity="0.18"/>
          <circle cx={x} cy={y} r={r} fill="none" stroke={c} strokeWidth="0.6"/>
          <text x={x} y={y+2} fontSize="7" fontFamily="serif" fontWeight="600" fill={c} textAnchor="middle">{l}</text>
        </g>
      ))}
      <line x1="60" y1="40" x2="140" y2="40" stroke="#1A2B4A" strokeOpacity="0.25" strokeWidth="0.4"/>
      <line x1="55" y1="80" x2="140" y2="85" stroke="#1A2B4A" strokeOpacity="0.25" strokeWidth="0.4"/>
    </svg>
  );
}

// ─── Concentric View ───────────────────────────────────────
function ConcentricView() {
  const data = React.useMemo(() => buildGraphData(), []);
  const W = 1240, H = 820, cx=W/2, cy=H/2;
  const tierR = { A:80, B:160, C:240, D:320, E:400 };
  return (
    <div style={{ position:'relative', width:'100%', height:'100%',
      background:'linear-gradient(180deg, var(--et-bg) 0%, #EFE5D2 100%)', overflow:'hidden' }}>
      <GraphChrome dark={false}/>
      <svg width={W} height={H} style={{ position:'absolute', inset:0, width:'100%', height:'100%' }} viewBox={`0 0 ${W} ${H}`}>
        {/* rings */}
        {Object.entries(tierR).map(([t,r]) => (
          <g key={t}>
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1A2B4A" strokeOpacity="0.12" strokeDasharray="2 4"/>
            <text x={cx + r + 8} y={cy + 4} fontSize="11" fill="rgba(26,43,74,0.55)" fontFamily="var(--et-sans)" fontWeight="600">{t}</text>
          </g>
        ))}
        {/* nodes on their ring */}
        {data.nodes.filter(n=>!n.isSelf).map((n, i) => {
          const r = tierR[n.tier] || 380;
          const angle = (i * 137.5) * Math.PI / 180; // golden angle for spread
          const jitter = (i % 7) * 6 - 18;
          const rr = r + jitter;
          const x = cx + Math.cos(angle) * rr;
          const y = cy + Math.sin(angle) * rr * 0.6; // squish vertically
          return (
            <circle key={n.id} cx={x} cy={y} r={n.size*0.7} fill={n.color}
              stroke="rgba(255,255,255,0.6)" strokeWidth="0.5"/>
          );
        })}
        {/* self */}
        <circle cx={cx} cy={cy} r="40" fill="url(#self-glow)"/>
        <circle cx={cx} cy={cy} r="14" fill="#FFE6CF" stroke="#FF6B47" strokeWidth="0.5"/>
        <text x={cx} y={cy+45} textAnchor="middle" fontFamily="var(--et-serif)" fontSize="14" fontWeight="600" fill="#1A2B4A">你</text>
        <defs>
          <radialGradient id="self-glow"><stop offset="0%" stopColor="#FF6B47" stopOpacity="0.5"/><stop offset="100%" stopColor="#FF6B47" stopOpacity="0"/></radialGradient>
        </defs>
      </svg>
      <Legend dark={false}/>
      <OverviewPanel stats={data.stats} dark={false}/>
    </div>
  );
}

// ─── Time Orbit View ───────────────────────────────────────
function TimeOrbitView() {
  const data = React.useMemo(() => buildGraphData(), []);
  const W = 1240, H = 820;
  const padL = 100, padR = 60, padT = 120, padB = 100;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const years = [2018, 2020, 2022, 2024, 2026];

  return (
    <div style={{ position:'relative', width:'100%', height:'100%',
      background:'linear-gradient(180deg, var(--et-bg) 0%, #EFE5D2 100%)', overflow:'hidden' }}>
      <GraphChrome dark={false}/>
      <svg width={W} height={H} style={{ position:'absolute', inset:0, width:'100%', height:'100%' }} viewBox={`0 0 ${W} ${H}`}>
        {/* axes */}
        <line x1={padL} y1={padT+innerH} x2={W-padR} y2={padT+innerH} stroke="#1A2B4A" strokeOpacity="0.4" strokeWidth="0.5"/>
        <line x1={padL} y1={padT} x2={padL} y2={padT+innerH} stroke="#1A2B4A" strokeOpacity="0.4" strokeWidth="0.5"/>
        {/* x ticks */}
        {years.map((y,i) => {
          const x = padL + (i / (years.length-1)) * innerW;
          return (
            <g key={y}>
              <line x1={x} y1={padT+innerH} x2={x} y2={padT+innerH+5} stroke="#1A2B4A" strokeOpacity="0.4" strokeWidth="0.5"/>
              <text x={x} y={padT+innerH+22} fontSize="11" fontFamily="var(--et-sans)" fontWeight="600" textAnchor="middle" fill="rgba(26,43,74,0.7)">{y}</text>
            </g>
          );
        })}
        {/* y axis label */}
        <text x={padL-12} y={padT+innerH/2} fontSize="10" fontFamily="var(--et-sans)" fontWeight="600" letterSpacing="0.18em" fill="rgba(26,43,74,0.55)" textAnchor="middle" transform={`rotate(-90 ${padL-12} ${padT+innerH/2})`}>关系深度 →</text>
        <text x={padL+innerW/2} y={padT+innerH+50} fontSize="10" fontFamily="var(--et-sans)" fontWeight="600" letterSpacing="0.18em" fill="rgba(26,43,74,0.55)" textAnchor="middle">认识年份 →</text>

        {/* trail orbits per node */}
        {data.nodes.filter(n=>!n.isSelf && !n.isolated).slice(0, 60).map((n, i) => {
          const startYear = 2018 + Math.random() * 7;
          const x = padL + ((startYear-2018)/(2026-2018)) * innerW;
          const depth = n.tier==='A' ? 0.85 : n.tier==='B' ? 0.6 : n.tier==='C' ? 0.35 : 0.18;
          const y = padT + (1 - depth) * innerH;
          // a curved trail
          const cx1 = x + 30, cy1 = y - 10;
          const x2  = x + 60 + Math.random()*80, y2 = y + (Math.random()-0.5)*40;
          return (
            <g key={n.id}>
              <path d={`M${x},${y+10} Q${cx1},${cy1} ${x2},${y2}`}
                stroke={n.color} strokeWidth="0.6" fill="none" opacity="0.35"/>
              <circle cx={x} cy={y} r={n.size*0.6} fill={n.color} opacity="0.95"/>
            </g>
          );
        })}
        {/* self band — horizontal line at top */}
        <line x1={padL} y1={padT+10} x2={W-padR} y2={padT+10} stroke="#FF6B47" strokeWidth="1" strokeDasharray="6 4" opacity="0.6"/>
        <text x={padL} y={padT-2} fontSize="11" fontFamily="var(--et-serif)" fontStyle="italic" fontWeight="600" fill="#1A2B4A">你 · 起点</text>
      </svg>
      <Legend dark={false}/>
    </div>
  );
}

Object.assign(window, {
  GraphView, GraphSidePanel, ViewSwitcherMenu, ConcentricView, TimeOrbitView,
});
