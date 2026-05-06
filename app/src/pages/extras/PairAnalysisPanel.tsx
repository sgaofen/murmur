// app/src/pages/extras/PairAnalysisPanel.tsx
//
// Round 2 — replaces the three-button PairExportRow at the top of Graph.tsx's
// pair drawer. Productizes the export as Murmur's signature feature.
//
// Adapted from Claude Design's Round 2 deliverable with these reality-fixes:
//   - Props take wxid strings + display names (Graph.tsx doesn't have Friend
//     objects on hand at the pair drawer scope; building minimal stand-ins
//     internally lets Avatar render without an extra round-trip)
//   - Stamp prop is `label` not `text`

import { useState } from 'react';
import type { Friend } from '../../data/types';
import { Avatar } from '../../components/Avatar';
import { displayName } from '../../utils/privacy';
import { Download, Sparkle, Code, Archive, Lock, Info } from '../../utils/icons';
import { exportPairChat, type ExportFormat } from '../../data/api';

interface Props {
  a: string;       // wxid
  b: string;       // wxid
  aName?: string;  // display name (caller already has these from Graph)
  bName?: string;
}

interface Format {
  id: 'md' | 'json' | 'html';
  label: string;
  ext: string;
  tagline: string;
  body: string;
  icon: React.ReactNode;
}

const FORMATS: Format[] = [
  {
    id: 'md', label: 'Markdown', ext: '.md',
    tagline: '给 ChatGPT / Claude 在线 AI',
    body: '把整段关系丢给在线模型，让它写小说、分析、生日卡。',
    icon: <Sparkle size={18} />,
  },
  {
    id: 'json', label: 'JSON', ext: '.json',
    tagline: '给脚本 / 自动化工具',
    body: '完整结构化字段：消息条数、主导比、共同的群、互相点赞的朋友圈。',
    icon: <Code size={18} />,
  },
  {
    id: 'html', label: 'HTML', ext: '.html',
    tagline: '离线归档 / 直接打印',
    body: '一个文件就能离线打开，带样式，送给本人或备份云盘都合适。',
    icon: <Archive size={18} />,
  },
];

// Cheap hue hash — same algorithm Graph uses for edge colors. Yields a
// stable color per wxid without async-fetching the real Friend record.
function hueOf(wxid: string): number {
  let h = 0;
  for (let i = 0; i < wxid.length; i++) h = (h * 31 + wxid.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function makeStubFriend(id: string, name: string): Friend {
  // Avatar pulls .id .name .hue .glyph; rest of Friend stays empty since
  // we never render those fields here.
  const cleaned = (name || id).replace(/[^A-Za-z0-9一-鿿]/g, '');
  const glyph = cleaned.slice(0, 2) || '?';
  return {
    id,
    name: name || id,
    count: 0,
    last: '',
    tag: '',
    tagKind: 'faint',
    hue: hueOf(id),
    glyph,
    knew: '',
    bond: '',
  };
}

export function PairAnalysisPanel({ a, b, aName, bName }: Props) {
  const [busy, setBusy] = useState<Format['id'] | null>(null);
  const aFriend = makeStubFriend(a, aName || a);
  const bFriend = makeStubFriend(b, bName || b);
  const aDisplay = displayName(a, aName || a);
  const bDisplay = displayName(b, bName || b);

  async function download(fmt: Format) {
    setBusy(fmt.id);
    try {
      // Goes through `exportPairChat` so it picks up the API_BASE absolute
      // URL (Tauri WebView resolves relative paths to `tauri://localhost/...`
      // which doesn't reach etcli on 127.0.0.1:9100).
      // 'md' is the export-format alias for the markdown pack; the helper
      // accepts our standard ExportFormat enum so we map md → txt internally.
      const apiFmt: ExportFormat = fmt.id === 'md' ? 'txt' : fmt.id;
      await exportPairChat(a, b, apiFmt);
    } catch (e) {
      console.warn('[PairAnalysisPanel]', e);
      alert('导出失败：' + (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-label="pair analysis export"
      style={{
        background: 'var(--et-paper)',
        border: '0.5px solid var(--et-line-2)',
        borderRadius: 'var(--et-r-lg)',
        boxShadow: 'var(--et-shadow-1)',
        padding: '22px 24px 20px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        className="et-num"
        style={{
          position: 'absolute', top: 14, right: 18,
          fontSize: 10, letterSpacing: '0.18em',
          color: 'var(--et-mute)', textTransform: 'uppercase',
        }}
      >
        MURMUR / PAIR EXPORT
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Avatar friend={aFriend} size={42} />
          <div
            className="et-serif"
            style={{
              margin: '0 12px',
              fontSize: 13,
              color: 'var(--et-orange)',
              fontStyle: 'italic',
            }}
          >
            ×
          </div>
          <Avatar friend={bFriend} size={42} />
        </div>

        <div style={{ marginLeft: 4, minWidth: 0 }}>
          <div
            className="et-serif"
            style={{ fontSize: 18, fontWeight: 600, color: 'var(--et-ink)', lineHeight: 1.3 }}
          >
            {aDisplay} <span style={{ color: 'var(--et-mute)', fontWeight: 400 }}>与</span> {bDisplay}
          </div>
          <div className="et-meta" style={{ marginTop: 2, fontSize: 12 }}>
            导出他们俩之间的关系全貌
          </div>
        </div>
      </div>

      <div
        style={{
          padding: '12px 14px',
          background: 'rgba(255,107,71,0.07)',
          border: '0.5px solid rgba(255,107,71,0.30)',
          borderRadius: 'var(--et-r)',
          marginBottom: 18,
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
        }}
      >
        <div style={{ paddingTop: 1, color: 'var(--et-orange)' }}>
          <Sparkle size={14} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            className="et-serif"
            style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--et-ink)', lineHeight: 1.5 }}
          >
            这是 Murmur 独有的一步
          </div>
          <div
            style={{
              marginTop: 2, fontSize: 12.5, lineHeight: 1.7, color: 'var(--et-ink-soft)',
            }}
          >
            市面上的工具只能导出&ldquo;你和他&rdquo;的聊天。Murmur 看得到他们俩私聊里互相提到的话、共处的群、互相点赞的朋友圈——所以能给出他们之间的完整画像。
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 10,
        }}
      >
        {FORMATS.map(f => {
          const isBusy = busy === f.id;
          return (
            <button
              key={f.id}
              onClick={() => download(f)}
              disabled={busy !== null}
              style={{
                all: 'unset',
                cursor: busy !== null ? 'wait' : 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: '14px 14px 12px',
                background: 'var(--et-paper-2)',
                border: '0.5px solid var(--et-line-2)',
                borderRadius: 'var(--et-r)',
                transition: 'transform .15s, border-color .15s, background .15s',
                opacity: busy && !isBusy ? 0.5 : 1,
              }}
              onMouseEnter={e => {
                if (busy) return;
                (e.currentTarget as HTMLElement).style.borderColor = 'var(--et-orange)';
                (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.borderColor = 'var(--et-line-2)';
                (e.currentTarget as HTMLElement).style.transform = '';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div
                  style={{
                    width: 30, height: 30, borderRadius: 8,
                    background: 'var(--et-paper)',
                    border: '0.5px solid var(--et-line-2)',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    color: 'var(--et-orange)',
                  }}
                >
                  {f.icon}
                </div>
                <span className="et-num" style={{ fontSize: 11, color: 'var(--et-mute)' }}>
                  {f.ext}
                </span>
              </div>

              <div>
                <div
                  className="et-serif"
                  style={{ fontSize: 15, fontWeight: 600, color: 'var(--et-ink)', lineHeight: 1.3 }}
                >
                  {f.label}
                </div>
                <div
                  className="et-body"
                  style={{ marginTop: 2, fontSize: 11.5, color: 'var(--et-orange)' }}
                >
                  {f.tagline}
                </div>
              </div>

              <div
                style={{
                  fontSize: 11.5, lineHeight: 1.6, color: 'var(--et-ink-soft)',
                }}
              >
                {f.body}
              </div>

              <div
                style={{
                  marginTop: 'auto',
                  paddingTop: 10,
                  borderTop: '0.5px solid var(--et-line)',
                  display: 'flex', alignItems: 'center', gap: 6,
                  color: isBusy ? 'var(--et-orange)' : 'var(--et-ink-soft)',
                  fontSize: 11.5, fontWeight: 600,
                }}
              >
                <Download size={12} />
                {isBusy ? '正在导出…' : `下载 ${f.label}`}
              </div>
            </button>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: '0.5px solid var(--et-line)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 14,
          color: 'var(--et-mute)',
          fontSize: 11.5,
          lineHeight: 1.6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <Lock size={11} /> 全部本地生成
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <Info size={11} /> 不发任何数据到外部服务器
        </div>
      </div>
    </section>
  );
}
