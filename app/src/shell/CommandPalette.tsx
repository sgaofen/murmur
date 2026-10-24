/* CommandPalette (⌘K / Ctrl K) — every page, a few global actions, and
 * every person / group, in one keyboard-first list.
 *
 * Modes: 'all' (the ⌘K key), 'profile' / 'chat' (the 3 档案 / 4 对话 keys
 * when no person has been opened yet — the list then starts at people and
 * Enter opens that person's profile or chat). Styles: ./shell.css (cmdk-*).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getAllFriends } from '../data/api';
import type { Friend } from '../data/types';
import { displayName, togglePrivacyMode } from '../utils/privacy';
import { usePrivacy } from '../utils/usePrivacy';
import { cx, setThemeMode, useTheme } from '../ui';

export type PaletteMode = 'all' | 'profile' | 'chat';

export interface PaletteNavItem {
  key: string;
  no: string;          // keycap ("1", "⌘,")
  label: string;
  hint: string;
  href: string | null; // null = needs a person (profile / chat)
}

interface Item {
  id: string;
  group: 'go' | 'people' | 'act';
  code: ReactNode;
  label: string;
  meta?: string;
  hint?: string;
  run: (e: { shift: boolean }) => void;
  /** Keep the palette open after running (switches the list instead). */
  stay?: boolean;
  /** Lower-cased text the query is matched against. */
  hay: string;
}

// People are fetched once per palette session and kept for a minute, so
// reopening ⌘K is instant but a fresh decrypt still shows up.
let peopleCache: { at: number; list: Friend[] } | null = null;

const GROUP_LABEL: Record<Item['group'], [string, string]> = {
  go: ['GO', '前往'],
  people: ['PEOPLE', '人与群'],
  act: ['ACT', '操作'],
};

export function CommandPalette({ open, mode, onClose, nav, navigate, onRequestOnboarding }: {
  open: boolean;
  mode: PaletteMode;
  onClose: () => void;
  nav: PaletteNavItem[];
  navigate: (hash: string) => void;
  onRequestOnboarding: () => void;
}) {
  if (!open) return null;
  return createPortal(
    <PaletteBody mode={mode} onClose={onClose} nav={nav} navigate={navigate} onRequestOnboarding={onRequestOnboarding} />,
    document.body,
  );
}

function PaletteBody({ mode: initialMode, onClose, nav, navigate, onRequestOnboarding }: {
  mode: PaletteMode;
  onClose: () => void;
  nav: PaletteNavItem[];
  navigate: (hash: string) => void;
  onRequestOnboarding: () => void;
}) {
  const privacyOn = usePrivacy();
  const { mode: themeMode } = useTheme();
  const [mode, setMode] = useState<PaletteMode>(initialMode);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [people, setPeople] = useState<Friend[] | null>(
    () => (peopleCache && Date.now() - peopleCache.at < 60_000 ? peopleCache.list : null),
  );
  const [peopleError, setPeopleError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => restore?.focus?.({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (people) return;
    let cancelled = false;
    getAllFriends({ kind: 'all' })
      .then(list => {
        peopleCache = { at: Date.now(), list };
        if (!cancelled) setPeople(list);
      })
      .catch(() => { if (!cancelled) setPeopleError(true); });
    return () => { cancelled = true; };
  }, [people]);

  const items = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase();
    const match = (it: Item) => !query || it.hay.includes(query);

    // 档案 / 对话 need a person: without a recent one they switch the list
    // to people instead of navigating.
    const goItems: Item[] = nav
      .filter(n => n.href || (mode === 'all' && (n.key === 'profile' || n.key === 'chat')))
      .map(n => ({
        id: `go:${n.key}`,
        group: 'go',
        code: <kbd className="ui-kbd">{n.no}</kbd>,
        label: n.label,
        hint: n.hint,
        stay: !n.href,
        run: () => {
          if (n.href) navigate(n.href);
          else { setMode(n.key === 'chat' ? 'chat' : 'profile'); setQ(''); setSel(0); }
        },
        hay: `${n.label} ${n.hint} ${n.key}`.toLowerCase(),
      }));

    // A group has no profile page: 档案 lists private chats only.
    const personItems: Item[] = (people ?? []).filter(f => mode !== 'profile' || !f.isGroup).map(f => {
      const name = displayName(f.id, f.name);
      const group = !!f.isGroup;
      return {
        id: `p:${f.id}`,
        group: 'people',
        code: <span className={cx('ui-tsq', group && 'is-faint')}>{group ? '群' : '人'}</span>,
        label: name,
        meta: `${f.count.toLocaleString()} 条${f.last && f.last !== '—' ? ` · ${f.last}` : ''}`,
        run: ({ shift }) => {
          const toChat = mode === 'chat' || (mode === 'all' && shift);
          navigate(toChat ? `chat/${encodeURIComponent(f.id)}` : `friend/${f.id}`);
        },
        // Privacy mode: match only what is on screen, never the hidden real name.
        hay: (privacyOn ? name : `${name} ${f.name} ${f.id}`).toLowerCase(),
      };
    });

    const actItems: Item[] = [
      { id: 'act:light', label: '外观 · 浅色（铝）', mode: 'light' as const },
      { id: 'act:dark', label: '外观 · 深色（石墨）', mode: 'dark' as const },
      { id: 'act:system', label: '外观 · 跟随系统', mode: 'system' as const },
    ].map(a => ({
      id: a.id,
      group: 'act' as const,
      code: <span className={cx('ui-led', themeMode !== a.mode && 'is-off')} />,
      label: a.label,
      meta: themeMode === a.mode ? '当前' : undefined,
      run: () => { setThemeMode(a.mode); },
      hay: `${a.label} theme appearance 主题 外观`.toLowerCase(),
    }));
    actItems.push({
      id: 'act:privacy',
      group: 'act',
      code: <span className={cx('ui-led', !privacyOn && 'is-off')} />,
      label: privacyOn ? '关闭隐私模式' : '开启隐私模式',
      hint: '录屏 / 截图前把名字、wxid、本机路径脱敏',
      run: () => { togglePrivacyMode(); },
      hay: '隐私模式 privacy 脱敏'.toLowerCase(),
    });
    actItems.push({
      id: 'act:onboarding',
      group: 'act',
      code: <kbd className="ui-kbd">＋</kbd>,
      label: '添加账号 / 重新走初始化引导',
      run: () => { onRequestOnboarding(); },
      hay: '添加账号 初始化 引导 onboarding 密钥 解密'.toLowerCase(),
    });

    const go = goItems.filter(match);
    // People are only listed when asked for (a query, or the 档案 / 对话 keys);
    // a cap keeps the list fast on accounts with thousands of chats.
    const ppl = (query || mode !== 'all') ? personItems.filter(match).slice(0, 40) : [];
    const act = actItems.filter(match);
    return mode === 'all' ? [...go, ...ppl, ...act] : [...ppl, ...go];
  }, [q, nav, people, mode, navigate, themeMode, privacyOn, onRequestOnboarding]);

  // Keep the selection inside the list as it shrinks / grows.
  const selected = Math.min(sel, Math.max(0, items.length - 1));

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  function runAt(i: number, shift: boolean) {
    const it = items[i];
    if (!it) return;
    if (!it.stay) onClose();
    it.run({ shift });
    if (it.stay) inputRef.current?.focus();
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(items.length - 1, selected + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, selected - 1)); return; }
    if (e.key === 'Enter') { e.preventDefault(); runAt(selected, e.shiftKey); return; }
    if (e.key === 'Tab') { e.preventDefault(); }  // focus stays in the input
  }

  const placeholder = mode === 'profile' ? '选择一个人，打开档案'
    : mode === 'chat' ? '选择一个人或群，打开对话'
    : '前往页面、找人、切换外观…';
  const title = mode === 'profile' ? '档案' : mode === 'chat' ? '对话' : '命令';

  let lastGroup: Item['group'] | null = null;
  const loadingPeople = !people && !peopleError && (q.trim() !== '' || mode !== 'all');

  return (
    <div className="cmdk-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label={`命令面板 · ${title}`} onKeyDown={onKeyDown}>
        <div className="cmdk__head">
          <span className="ui-mod__id">⌘K</span>
          <span className="ui-mod__title">{title}</span>
          <span className="cmdk__en">{mode === 'all' ? 'COMMAND' : mode === 'profile' ? 'OPEN PROFILE' : 'OPEN CHAT'}</span>
          <span className="cmdk__count">{items.length} ITEMS</span>
        </div>
        <label className="cmdk__query">
          <span className="cmdk__prompt" aria-hidden="true">&gt;</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            placeholder={placeholder}
            aria-label={placeholder}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={items[selected] ? `${listId}-${selected}` : undefined}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <div className="cmdk__list" role="listbox" id={listId} ref={listRef} aria-label="结果">
          {items.map((it, i) => {
            const head = it.group !== lastGroup;
            lastGroup = it.group;
            return (
              <div key={it.id} role="presentation">
                {head && (
                  <div className="cmdk__group" role="presentation">
                    {GROUP_LABEL[it.group][0]}<b>{GROUP_LABEL[it.group][1]}</b>
                  </div>
                )}
                <div
                  id={`${listId}-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === selected}
                  className={cx('cmdk__item', i === selected && 'is-sel')}
                  onMouseMove={() => { if (i !== selected) setSel(i); }}
                  onClick={(e) => runAt(i, e.shiftKey)}
                >
                  <span className="cmdk__code">{it.code}</span>
                  <span className="cmdk__label">{it.label}</span>
                  {it.hint && <span className="cmdk__hint">{it.hint}</span>}
                  {it.meta && <span className="cmdk__meta">{it.meta}</span>}
                </div>
              </div>
            );
          })}
          {loadingPeople && <div className="cmdk__note">正在读取联系人…</div>}
          {peopleError && (q.trim() !== '' || mode !== 'all') && (
            <div className="cmdk__note">联系人没能读取（本地服务没有响应），页面入口仍然可用。</div>
          )}
          {items.length === 0 && !loadingPeople && (
            <div className="cmdk__note">没有匹配「{q.trim()}」的结果。</div>
          )}
        </div>
        <div className="cmdk__foot">
          <span><kbd className="ui-kbd">↑↓</kbd>选择</span>
          <span><kbd className="ui-kbd">↵</kbd>{mode === 'chat' ? '打开对话' : '打开'}</span>
          {mode === 'all' && <span><kbd className="ui-kbd">⇧↵</kbd>人：打开对话</span>}
          <span><kbd className="ui-kbd">ESC</kbd>关闭</span>
        </div>
      </div>
    </div>
  );
}
