import { useEffect, useState } from 'react';
import type { LocalAgent } from '../../data/api';
import { getAgents } from '../../data/api';

export function LocalAgentPanel({
  selected, onSelect, onInvoke,
}: {
  selected: string | null;
  onSelect: (cli: string) => void;
  onInvoke: (cli: string) => void;
}) {
  const [agents, setAgents] = useState<LocalAgent[] | null>(null);

  useEffect(() => {
    getAgents().then(setAgents).catch(() => setAgents([]));
  }, []);

  if (agents === null) {
    return (
      <div className="et-meta" style={{ padding: 16, textAlign: 'center' }}>
        正在检测本机 AI…
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div style={{
        padding: '14px 16px', marginBottom: 18,
        background: 'rgba(26,43,74,0.04)',
        border: '0.5px dashed var(--et-line-2)',
        borderRadius: 'var(--et-r)',
      }}>
        <div className="et-meta" style={{ fontSize: 12, color: 'var(--et-mute)' }}>
          没在你电脑上检测到 Claude Code / Codex 命令行 AI。下面可以选「通用 AI」生成分析包，自己拷给在线 AI。
        </div>
      </div>
    );
  }

  return (
    <div style={{
      padding: '14px 16px',
      background: 'linear-gradient(180deg, var(--et-orange-soft), transparent 90%)',
      border: '0.5px solid rgba(224,83,46,0.28)',
      borderRadius: 'var(--et-r)', marginBottom: 18,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 14 }}>✨</span>
        <div className="et-serif" style={{ fontSize: 14, fontWeight: 600, color: 'var(--et-ink)' }}>
          检测到你电脑上有 <span style={{ color: 'var(--et-orange)' }}>{agents.length}</span> 个 AI 助手 — 直接调用吧
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {agents.map(a => {
          const active = selected === a.cli;
          return (
            <div key={a.cli} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 12px', borderRadius: 10,
              background: active ? 'var(--et-paper)' : 'rgba(255,255,255,0.45)',
              border: `0.5px solid ${active ? 'var(--et-orange)' : 'rgba(26,43,74,0.10)'}`,
              boxShadow: active ? '0 1px 0 rgba(255,255,255,0.6) inset, 0 4px 12px rgba(255,107,71,0.14)' : 'none',
              cursor: 'pointer',
            }}
            onClick={() => onSelect(a.cli)}
            >
              <span style={{
                width: 14, height: 14, borderRadius: '50%',
                border: `1.5px solid ${active ? 'var(--et-orange)' : 'var(--et-line-2)'}`,
                background: 'var(--et-paper)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                {active && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--et-orange)' }} />}
              </span>
              <span style={{
                width: 30, height: 30, borderRadius: 8,
                background: 'var(--et-ink)', color: 'var(--et-paper)',
                fontFamily: 'var(--et-serif)', fontWeight: 600, fontSize: 13,
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>{a.name.charAt(0)}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--et-ink)' }}>{a.name}</span>
                  <span className="et-meta" style={{ fontFamily: 'var(--et-mono)', fontSize: 11 }}>{a.vendor} · {a.version}</span>
                </div>
                <div className="et-meta" style={{ marginTop: 2 }}>「{describe(a.cli)}」</div>
              </div>
              {active && (
                <button
                  onClick={(e) => { e.stopPropagation(); onInvoke(a.cli); }}
                  style={{
                    all: 'unset', cursor: 'pointer',
                    padding: '5px 10px', borderRadius: 6,
                    background: 'var(--et-orange)', color: '#fff',
                    fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
                  }}
                >让它分析 →</button>
              )}
            </div>
          );
        })}
      </div>
      <div className="et-meta" style={{ marginTop: 10, fontSize: 11, color: 'var(--et-mute)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#48a76b' }} />
        由本机命令行启动 · Claude/Codex 会交给对应服务商处理
      </div>
    </div>
  );
}

function describe(cli: string): string {
  switch (cli) {
    case 'claude': return '我电脑上的 Claude，最聪明的助手';
    case 'codex': return 'OpenAI 出的命令行助手';
    default: return '本机 AI 工具';
  }
}
