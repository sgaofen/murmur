// app/src/pages/extras/PairAnalysisPanel.tsx
//
// Pair export — "他们俩之间" as a file. Used in Graph.tsx's pair drawer and in
// the profile page's 关联 module (inside a Dialog, `bare`). Four formats, one
// row each; the click downloads straight away. Styles: ./PairAnalysisPanel.css.

import { useState } from 'react';
import { displayName } from '../../utils/privacy';
import { exportPairChat } from '../../data/api';
import { cx } from '../../ui';
import './PairAnalysisPanel.css';

interface Props {
  a: string;       // wxid
  b: string;       // wxid
  aName?: string;  // display name (caller already has these from Graph)
  bName?: string;
  /** Inside a Dialog that already names the pair: drop the frame + heading. */
  bare?: boolean;
}

interface Format {
  id: 'md' | 'json' | 'html' | 'csv';
  label: string;
  ext: string;
  tagline: string;
  body: string;
}

const FORMATS: Format[] = [
  {
    id: 'md', label: 'Markdown', ext: '.md',
    tagline: '给 ChatGPT / Claude 在线 AI',
    body: '把整段关系丢给在线模型，让它写小说、分析、生日卡。',
  },
  {
    id: 'json', label: 'JSON', ext: '.json',
    tagline: '给脚本 / 自动化工具',
    body: '完整结构化字段：消息条数、主导比、共同的群、互相点赞的朋友圈。',
  },
  {
    id: 'html', label: 'HTML', ext: '.html',
    tagline: '离线归档 / 直接打印',
    body: '一个文件就能离线打开，带样式，送给本人或备份云盘都合适。',
  },
  {
    id: 'csv', label: 'CSV', ext: '.csv',
    tagline: '用 Excel / Numbers 打开',
    body: '每条关系证据一行：提及、互回、朋友圈互动、共同的群，方便筛选排序。',
  },
];

/** 「朋友 PB」→ PB for the compact pair code; anything else stays whole. */
function code(name: string): string {
  const m = /^(?:朋友|群)\s*(\S{1,3})$/.exec(name);
  return m ? m[1] : name;
}

export function PairAnalysisPanel({ a, b, aName, bName, bare = false }: Props) {
  const [busy, setBusy] = useState<Format['id'] | null>(null);
  const [done, setDone] = useState<Format['id'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const aDisplay = displayName(a, aName || a);
  const bDisplay = displayName(b, bName || b);

  async function download(fmt: Format) {
    setBusy(fmt.id);
    setDone(null);
    setError(null);
    try {
      // Goes through `exportPairChat` so it picks up the API_BASE absolute
      // URL (Tauri WebView resolves relative paths to `tauri://localhost/...`
      // which doesn't reach etcli on 127.0.0.1:9100).
      await exportPairChat(a, b, fmt.id);
      setDone(fmt.id);
    } catch (e) {
      console.warn('[PairAnalysisPanel]', e);
      setError((e as Error).message || String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="双人导出" className={cx('pap', bare && 'pap--bare')}>
      {!bare && (
        <header className="pap__head">
          <span className="ui-label">PAIR EXPORT<b>双人导出</b></span>
          <span className="pap__codes">{code(aDisplay)} × {code(bDisplay)}</span>
        </header>
      )}
      {!bare && (
        <div className="pap__who">
          <div className="pap__names">{aDisplay}<span>与</span>{bDisplay}</div>
          <div className="pap__sub">导出他们俩之间的关系全貌</div>
        </div>
      )}
      <p className="pap__note">
        普通的导出只有「你和他」的聊天。这里汇总的是他们俩之间的痕迹：私聊里互相提到的话、共处的群、互相点赞的朋友圈。
      </p>
      <ul className="pap__list">
        {FORMATS.map(f => {
          const isBusy = busy === f.id;
          return (
            <li key={f.id}>
              <button
                type="button"
                className={cx('pap__row', isBusy && 'is-busy')}
                onClick={() => download(f)}
                disabled={busy !== null}
              >
                <span className="pap__ext">{f.ext}</span>
                <span className="pap__txt">
                  <span className="pap__label">{f.label}<em>{f.tagline}</em></span>
                  <span className="pap__body">{f.body}</span>
                </span>
                <span className="pap__go">{isBusy ? '导出中…' : done === f.id ? '已下载' : '下载'}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {error && <p className="pap__err" role="alert">导出失败：{error}</p>}
      <footer className="pap__foot">全部本地生成 · 不发任何数据到外部服务器</footer>
    </section>
  );
}
