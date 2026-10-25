/* ReportReader — the long-form reading view for an AI relationship report.
 *
 * Used by the profile page (opening a saved report) and by the local-agent
 * flow (RelationshipReportView, once the agent is done). It fills the area
 * between the status strip and the key bar (`.app-fill`) with its own
 * scroller: a numbered contents rail on the left, one comfortable reading
 * column on the right (15px / 1.95 — the reading measure borrowed from the
 * C 「手札」 direction, set in the B instrument's greys).
 *
 * Callers pass text that is already privacy-masked; markdown goes through
 * utils/markdown (which escapes HTML) before it is injected. Styles:
 * ./ReportReader.css. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { mdToHtml } from '../../utils/markdown';
import { Button, cx } from '../../ui';
import './ReportReader.css';

export interface ReportSection {
  id: string;
  no: string;
  title: string;
  md: string;
  chars: number;
}

export interface ParsedReport {
  /** The report's own `# …` title, when it has one. */
  title: string | null;
  sections: ReportSection[];
  chars: number;
}

const NUMBERING = /^(?:\d+|[一二三四五六七八九十]+)\s*[.、．:：)]\s*/;

/** Characters a reader actually reads (markdown syntax and spaces excluded). */
export function readableLength(md: string): number {
  return md.replace(/[#>*`|_~-]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, '').length;
}

/** Split a report into sections at its `#` / `##` headings. The frontmatter
 * the agents write (`# name 关系档案`, `> 由 … 生成`, `---`) is dropped, the
 * same way the backend trims it for the short preview. */
export function parseReport(md: string): ParsedReport {
  let text = (md || '').replace(/\r\n/g, '\n').trim();
  let title: string | null = null;
  const h1 = /^#\s+(.+)\n/.exec(text);
  if (h1) title = h1[1].trim();
  const fm = text.indexOf('\n---\n');
  if (fm >= 0 && fm < 800) text = text.slice(fm + 5);
  else if (h1) text = text.slice(h1[0].length);
  const lines = text.split('\n');
  const out: { title: string; lines: string[] }[] = [];
  let cur: { title: string; lines: string[] } = { title: '', lines: [] };
  for (const line of lines) {
    const m = /^#{1,2}\s+(.+)$/.exec(line);
    if (m) {
      if (cur.title || cur.lines.some(l => l.trim())) out.push(cur);
      cur = { title: m[1].replace(/\*\*/g, '').trim(), lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  if (cur.title || cur.lines.some(l => l.trim())) out.push(cur);
  const sections = out
    .map((s, i) => {
      const body = s.lines.join('\n').replace(/^\s*---+\s*$/gm, '').trim();
      return {
        id: `rr-sec-${i}`,
        no: String(i + 1).padStart(2, '0'),
        title: (s.title || '导语').replace(NUMBERING, ''),
        md: body,
        chars: readableLength(body),
      };
    })
    .filter(s => s.md || s.title);
  return { title, sections, chars: sections.reduce((n, s) => n + s.chars, 0) };
}

/** The first paragraph of a markdown body as plain text. */
export function firstParagraph(md: string): string {
  const para = md.split(/\n\s*\n/).map(p => p.trim()).find(p => p && !/^[-*>|#]/.test(p)) || '';
  return para.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s*\n\s*/g, '');
}

/** A headline + one paragraph for the profile's report module: the first
 * section whose heading reads like a sentence (not 「1. 关系定性」). */
export function reportHeadline(p: ParsedReport, fallback: string): { title: string; summary: string } {
  const first = p.sections[0];
  const named = p.sections.find(s => s.title !== '导语' && s.md && !NUMBERING.test(s.title) && s.title.length >= 8);
  const src = named ?? first;
  return {
    title: named ? named.title : fallback,
    summary: src ? firstParagraph(src.md) : '',
  };
}

export interface ReportReaderProps {
  /** Module header: number + Chinese name + mono subtitle. */
  id?: string;
  label?: string;
  title: ReactNode;
  meta?: ReactNode;
  sections: ReportSection[];
  /** Plain text shown when the report has no headings to split on. */
  raw?: string;
  actions?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  /** Opened over the profile page (modal, Esc closes) or as the page itself. */
  modal?: boolean;
  /** Section to scroll to when the reader opens. */
  initial?: string | null;
}

export function ReportReader({
  id = '18', label = 'AI 关系报告', title, meta, sections, raw, actions, onClose, closeLabel = '关闭',
  modal = true, initial = null,
}: ReportReaderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(initial ?? sections[0]?.id ?? null);
  const total = useMemo(() => sections.reduce((n, s) => n + s.chars, 0) || readableLength(raw || ''), [sections, raw]);
  const htmls = useMemo(() => sections.map(s => mdToHtml(s.md)), [sections]);

  // Focus in, Esc out, focus back to whatever opened it.
  useEffect(() => {
    if (!modal) return;
    const before = document.activeElement as HTMLElement | null;
    rootRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      before?.focus?.({ preventScroll: true });
    };
  }, [modal, onClose]);

  useLayoutEffect(() => {
    if (!initial) return;
    const el = document.getElementById(initial);
    const box = scrollRef.current;
    if (el && box) box.scrollTop = el.offsetTop - 24;
  }, [initial]);

  // Contents highlight: the last section whose top has passed the reading line.
  const onScroll = () => {
    const box = scrollRef.current;
    if (!box || !sections.length) return;
    const line = box.scrollTop + box.clientHeight * 0.28;
    let cur = sections[0].id;
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el && el.offsetTop <= line) cur = s.id;
    }
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) cur = sections[sections.length - 1].id;
    if (cur !== active) setActive(cur);
  };

  const go = (sid: string) => {
    const el = document.getElementById(sid);
    const box = scrollRef.current;
    if (!el || !box) return;
    box.scrollTo({ top: el.offsetTop - 24, behavior: 'smooth' });
    setActive(sid);
  };

  return (
    <div
      ref={rootRef}
      className={cx('rr app-fill', !modal && 'rr--page')}
      role={modal ? 'dialog' : 'region'}
      aria-modal={modal || undefined}
      aria-label={typeof title === 'string' ? title : label}
      tabIndex={-1}
    >
      <header className="rr__bar">
        <span className="rr__id">{id}</span>
        <span className="rr__label">{label}</span>
        <span className="rr__en">
          READ{sections.length > 0 && ` · ${sections.length} SECTIONS`} · {total.toLocaleString('en-US')} 字
        </span>
        <span className="rr__actions">
          {actions}
          {onClose && (
            <Button size="sm" kbd={modal ? 'Esc' : undefined} onClick={onClose}>{closeLabel}</Button>
          )}
        </span>
      </header>
      <div className="rr__scroll" ref={scrollRef} onScroll={onScroll}>
        <div className={cx('rr__grid', sections.length < 2 && 'rr__grid--solo')}>
          {sections.length >= 2 && (
            <nav className="rr__toc" aria-label="目录">
              <div className="ui-label rr__toc-head">CONTENTS<b>目录</b></div>
              <ol>
                {sections.map(s => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={cx('rr__toc-item', active === s.id && 'is-on')}
                      aria-current={active === s.id ? 'true' : undefined}
                      onClick={() => go(s.id)}
                    >
                      <span className="rr__toc-no">{s.no}</span>
                      <span className="rr__toc-t">{s.title}</span>
                      <span className="rr__toc-n">{s.chars.toLocaleString('en-US')}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          )}
          <article className="rr__doc">
            <div className="ui-label">REPORT<b>关系档案</b></div>
            <h1 className="rr__title">{title}</h1>
            {meta && <div className="rr__meta">{meta}</div>}
            {sections.map((s, i) => (
              <section key={s.id} id={s.id} className="rr__sec">
                <h2 className="rr__h">
                  <span className="rr__no">{s.no}</span>
                  <span>{s.title}</span>
                </h2>
                <div className="rr__prose" dangerouslySetInnerHTML={{ __html: htmls[i] }} />
              </section>
            ))}
            {!sections.length && raw && <div className="rr__prose rr__raw">{raw}</div>}
            <div className="rr__end" aria-hidden="true">END · {total.toLocaleString('en-US')} 字</div>
          </article>
        </div>
      </div>
    </div>
  );
}
