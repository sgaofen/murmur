import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Friend } from '../data/types';
import { generateAIPack, openFolder } from '../data/api';
import { displayName } from '../utils/privacy';
import { LocalAgentPanel } from './extras/LocalAgentPanel';

interface Props {
  open: boolean;
  onClose: () => void;
  friend: Friend;
  onLocalAgent?: (cli: string) => void;  // user picked a local agent → switch to AgentReport view
}

interface GeneratedPack {
  ok: boolean;
  path: string;
  size: number;
  name: string;
  content: string;
}

export function AIExportDialog({ open, onClose, friend, onLocalAgent }: Props) {
  const [step, setStep] = useState(1);
  const [ai, setAi] = useState('Claude');
  const [range, setRange] = useState('year');
  const [focus, setFocus] = useState<Record<string, boolean>>({ qual: true, rhythm: true, persona: true, emotion: false, topics: false, advice: false });
  const [generating, setGenerating] = useState(false);
  const [pack, setPack] = useState<GeneratedPack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localAgentSelected, setLocalAgentSelected] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep(1);
      setPack(null);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      // sample size depends on range: more samples for "all"
      const sample = range === 'all' ? 120 : range === 'year' ? 80 : 60;
      const r = await generateAIPack(friend.id, { sample });
      setPack(r);
      setStep(2);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 10,
      background: 'rgba(20,24,42,0.42)',
      backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div style={{
        width: 560, maxWidth: '92%',
        background: 'var(--et-paper)', borderRadius: 'var(--et-r-lg)',
        boxShadow: 'var(--et-shadow-3)',
        border: '0.5px solid var(--et-line-2)',
        overflow: 'hidden', position: 'relative',
      }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, background: 'var(--et-orange)' }} />
        <button onClick={onClose} style={{
          position: 'absolute', top: 14, right: 14, all: 'unset', cursor: 'pointer',
          width: 28, height: 28, borderRadius: 8, color: 'var(--et-mute)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l8 8M11 3l-8 8" strokeLinecap="round" />
          </svg>
        </button>
        <div style={{ padding: '22px 28px 0' }}>
          <div className="et-eyebrow" style={{ color: 'var(--et-orange)' }}>导出 · 给 AI 分析</div>
          <div className="et-h2" style={{ color: 'var(--et-ink)', marginTop: 6 }}>
            {step === 1 ? `把和 ${displayName(friend.id, friend.name)} 的对话打包成一份分析材料` : '搞定！文件已经准备好。'}
          </div>
        </div>
        {error && (
          <div style={{
            margin: '12px 28px 0', padding: '10px 14px',
            background: 'rgba(196,90,63,0.12)', border: '0.5px solid rgba(196,90,63,0.4)',
            borderRadius: 8, fontSize: 12, color: 'var(--et-rose)',
          }}>生成失败：{error}</div>
        )}
        {step === 1 ? (
          <>
            <div style={{ padding: '14px 28px 0' }}>
              <LocalAgentPanel
                selected={localAgentSelected}
                onSelect={setLocalAgentSelected}
                onInvoke={(cli) => onLocalAgent?.(cli)}
              />
            </div>
            <Step1
              ai={ai} setAi={setAi}
              range={range} setRange={setRange}
              focus={focus} setFocus={setFocus}
              generating={generating}
              onNext={handleGenerate}
            />
          </>
        ) : (
          <Step2 onClose={onClose} pack={pack!} />
        )}
      </div>
    </div>
  );
}

function Section({ step, label, children }: { step: string; label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <span className="et-serif" style={{ fontSize: 15, fontWeight: 600, color: 'var(--et-orange)' }}>{step}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--et-ink)' }}>{label}</span>
      </div>
      {children}
    </div>
  );
}

interface Step1Props {
  ai: string;
  setAi: (s: string) => void;
  range: string;
  setRange: (s: string) => void;
  focus: Record<string, boolean>;
  setFocus: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  generating: boolean;
  onNext: () => void;
}

function Step1({ ai, setAi, range, setRange, focus, setFocus, generating, onNext }: Step1Props) {
  const ais = ['ChatGPT', 'Claude', '豆包', '文心一言', 'DeepSeek', 'Kimi', '通用（任何 AI）'];
  const ranges = [
    { id: 'all',  label: '全部聊天记录', sub: '完整数据 · 文件最大' },
    { id: 'year', label: '最近一年',     sub: '推荐 · 平衡' },
    { id: 'cust', label: '自定义时间…',  sub: '即将支持' },
  ];
  const focuses = [
    { k: 'qual',    label: '关系定性',     hint: '我们到底是什么关系' },
    { k: 'rhythm',  label: '互动节奏',     hint: '谁更主动 / 回应速度' },
    { k: 'persona', label: '人物画像',     hint: '对方大概是怎样一个人' },
    { k: 'emotion', label: '情感曲线',     hint: '热度有没有变化' },
    { k: 'topics',  label: '话题演变',     hint: '我们最近在聊什么' },
    { k: 'advice',  label: '给我具体建议', hint: '下一步可以做什么' },
  ];
  return (
    <div style={{ padding: '18px 28px 22px' }}>
      <Section step="①" label="选择给哪个 AI 看">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {ais.map(a => (
            <button key={a} onClick={() => setAi(a)} style={{
              all: 'unset', cursor: 'pointer', textAlign: 'center',
              padding: '10px 6px', borderRadius: 10,
              background: ai === a ? 'var(--et-ink)' : 'transparent',
              color: ai === a ? 'var(--et-paper)' : 'var(--et-ink)',
              border: `0.5px solid ${ai === a ? 'var(--et-ink)' : 'var(--et-line-2)'}`,
              fontSize: 12, fontWeight: ai === a ? 600 : 500,
              gridColumn: a === '通用（任何 AI）' ? 'span 2' : 'auto',
            }}>{a}</button>
          ))}
        </div>
      </Section>
      <Section step="②" label="数据范围">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ranges.map(r => (
            <button
              key={r.id}
              onClick={() => r.id !== 'cust' && setRange(r.id)}
              disabled={r.id === 'cust'}
              style={{
                all: 'unset', cursor: r.id === 'cust' ? 'not-allowed' : 'pointer',
                padding: '10px 14px', borderRadius: 10,
                display: 'flex', alignItems: 'center', gap: 12,
                border: `0.5px solid ${range === r.id ? 'var(--et-orange)' : 'var(--et-line-2)'}`,
                background: range === r.id ? 'var(--et-orange-soft)' : 'transparent',
                opacity: r.id === 'cust' ? 0.4 : 1,
              }}
            >
              <span style={{
                width: 14, height: 14, borderRadius: '50%',
                border: `1.5px solid ${range === r.id ? 'var(--et-orange)' : 'var(--et-line-2)'}`,
                background: 'var(--et-paper)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                {range === r.id && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--et-orange)' }} />}
              </span>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--et-ink)' }}>{r.label}</span>
              <span className="et-meta" style={{ marginLeft: 'auto' }}>{r.sub}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section step="③" label="分析侧重">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {focuses.map(f => (
            <label key={f.k} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 12px', borderRadius: 10, cursor: 'pointer',
              border: `0.5px solid ${focus[f.k] ? 'rgba(224,83,46,0.4)' : 'var(--et-line-2)'}`,
              background: focus[f.k] ? 'var(--et-orange-soft)' : 'transparent',
            }}>
              <span style={{
                width: 14, height: 14, borderRadius: 4, flexShrink: 0,
                border: `1.5px solid ${focus[f.k] ? 'var(--et-orange)' : 'var(--et-line-2)'}`,
                background: focus[f.k] ? 'var(--et-orange)' : 'transparent',
                color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {focus[f.k] && (
                  <svg width="9" height="9" viewBox="0 0 9 9">
                    <path d="M1.5 4.5L3.6 6.6L7.5 2.5" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <input type="checkbox" checked={focus[f.k]} onChange={() => setFocus({ ...focus, [f.k]: !focus[f.k] })} style={{ display: 'none' }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--et-ink)' }}>{f.label}</div>
                <div className="et-meta" style={{ fontSize: 11 }}>{f.hint}</div>
              </div>
            </label>
          ))}
        </div>
      </Section>
      <button onClick={onNext} disabled={generating} style={{
        all: 'unset', cursor: generating ? 'wait' : 'pointer', display: 'block', width: '100%', textAlign: 'center',
        padding: '14px 0', marginTop: 8,
        background: 'var(--et-orange)', color: '#fff',
        borderRadius: 'var(--et-r)', fontSize: 14, fontWeight: 600,
        boxShadow: '0 6px 16px rgba(255,107,71,0.32)',
        opacity: generating ? 0.7 : 1,
      }}>{generating ? '正在生成…' : '生成 AI 分析包'}</button>
    </div>
  );
}

function Step2({ onClose, pack }: { onClose: () => void; pack: GeneratedPack }) {
  const [copied, setCopied] = useState(false);
  const [opened, setOpened] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(pack.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      alert('复制失败，请手动打开文件复制');
    }
  }

  async function handleOpenFolder() {
    try {
      await openFolder(pack.path);
      setOpened(true);
      setTimeout(() => setOpened(false), 2000);
    } catch (e) {
      alert('打开失败：' + (e as any).message);
    }
  }

  const sizeKB = (pack.size / 1024).toFixed(1);

  return (
    <div style={{ padding: '18px 28px 22px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '14px 16px', borderRadius: 'var(--et-r)',
        background: 'var(--et-orange-soft)', border: '0.5px dashed rgba(224,83,46,0.36)',
        marginBottom: 18,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: 'var(--et-orange)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0,
        }}>✓</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--et-ink)' }}>已生成：{pack.name}</div>
          <div className="et-meta" style={{ fontFamily: 'var(--et-mono)', marginTop: 2, fontSize: 11, wordBreak: 'break-all' }}>{pack.path} · {sizeKB} KB</div>
        </div>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--et-ink)', marginBottom: 10 }}>接下来三选一：</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ActionRow
          color="#48a76b"
          label="直接拖进 ChatGPT/豆包 等聊天框"
          sub="AI 会自己读完并给出分析。最简单。"
          cta="打开文件位置"
          done={opened ? '已打开' : null}
          onClick={handleOpenFolder}
        />
        <ActionRow
          color="#d99a2b"
          label="复制全文到聊天框"
          sub={`共约 ${pack.content.length.toLocaleString()} 字，内含 prompt 和摘要数据。`}
          cta="一键复制全部内容"
          done={copied ? '已复制' : null}
          onClick={handleCopy}
        />
        <ActionRow
          color="var(--et-sky)"
          label="在文件管理器里查看"
          sub="打开后可以再编辑、再分享。"
          cta="打开文件夹"
          done={null}
          onClick={handleOpenFolder}
        />
      </div>
      <div className="et-meta" style={{ marginTop: 16, color: 'var(--et-mute)', textAlign: 'center' }}>
        小提示：文件已包含分析提示词，你不需要再向 AI 输入任何东西。
      </div>
      <button onClick={onClose} style={{
        all: 'unset', cursor: 'pointer', display: 'block', margin: '14px auto 0',
        padding: '8px 18px', fontSize: 12, color: 'var(--et-mute)',
      }}>关闭</button>
    </div>
  );
}

function ActionRow({ color, label, sub, cta, done, onClick }: {
  color: string; label: string; sub: string; cta: string; done: string | null; onClick: () => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '14px 16px', borderRadius: 12,
      background: 'var(--et-paper-2)', border: '0.5px solid var(--et-line-2)',
    }}>
      <div style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--et-ink)' }}>{label}</div>
        <div className="et-meta" style={{ marginTop: 2 }}>{sub}</div>
      </div>
      <button onClick={onClick} style={{
        all: 'unset', cursor: 'pointer',
        padding: '7px 14px', borderRadius: 8,
        background: done ? '#48a76b' : 'var(--et-ink)', color: 'var(--et-paper)',
        fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0,
      }}>{done || cta}</button>
    </div>
  );
}
