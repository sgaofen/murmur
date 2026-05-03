import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { maskText } from '../../utils/privacy';
import { usePrivacy } from '../../utils/usePrivacy';

// ─── Types ───
export type TaskIcon = 'key' | 'lock' | 'agent' | 'index';
export type TaskStatus = 'run' | 'done' | 'error';
export interface Task {
  id: string;
  icon: TaskIcon;
  name: string;
  sub: string;
  pct: number;        // 0..100
  status: TaskStatus;
  action?: string;
  startedAt: number;
}

// ─── Store hook ───
interface TaskStore {
  tasks: Task[];
  addTask: (t: Omit<Task, 'id' | 'startedAt'> & { id?: string }) => string;
  updateTask: (id: string, patch: Partial<Task>) => void;
  removeTask: (id: string) => void;
  clearDone: () => void;
}

const Ctx = createContext<TaskStore | null>(null);

export function TaskCenterProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]);

  const addTask: TaskStore['addTask'] = useCallback((t) => {
    const id = t.id || `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setTasks(ts => [...ts, { ...t, id, startedAt: Date.now() }]);
    return id;
  }, []);

  const updateTask: TaskStore['updateTask'] = useCallback((id, patch) => {
    setTasks(ts => ts.map(t => t.id === id ? { ...t, ...patch } : t));
  }, []);

  const removeTask: TaskStore['removeTask'] = useCallback((id) => {
    setTasks(ts => ts.filter(t => t.id !== id));
  }, []);

  const clearDone: TaskStore['clearDone'] = useCallback(() => {
    setTasks(ts => ts.filter(t => t.status === 'run'));
  }, []);

  // Auto-cleanup: tasks that completed > 5 min ago
  useEffect(() => {
    const id = setInterval(() => {
      setTasks(ts => ts.filter(t => t.status === 'run' || (Date.now() - t.startedAt) < 5 * 60 * 1000));
    }, 30000);
    return () => clearInterval(id);
  }, []);

  return <Ctx.Provider value={{ tasks, addTask, updateTask, removeTask, clearDone }}>{children}</Ctx.Provider>;
}

export function useTaskCenter(): TaskStore {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTaskCenter must be used inside TaskCenterProvider');
  return v;
}

// ─── Bell icon ───
export function TaskCenterBell({ onClick, active }: { onClick: () => void; active: boolean }) {
  const { tasks } = useTaskCenter();
  const count = tasks.filter(t => t.status === 'run').length;
  return (
    <button onClick={onClick} title="后台任务" style={{
      all: 'unset', cursor: 'pointer', position: 'relative',
      width: 32, height: 32, borderRadius: 8,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: active ? 'var(--et-orange-soft)' : 'transparent',
      color: active ? 'var(--et-orange-2)' : 'var(--et-mute)',
    }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M8 2v1M4 7a4 4 0 018 0v3l1 2H3l1-2V7zM6.5 13a1.5 1.5 0 003 0" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {count > 0 && (
        <span style={{
          position: 'absolute', top: 4, right: 4,
          minWidth: 14, height: 14, padding: '0 3px', borderRadius: 999,
          background: 'var(--et-orange)', color: '#fff',
          fontSize: 9, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--et-sans)',
          boxShadow: '0 0 0 2px var(--et-paper)',
        }}>{count}</span>
      )}
    </button>
  );
}

// ─── Drawer ───
const TASK_ICONS: Record<TaskIcon, React.ReactNode> = {
  key: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="4" cy="7" r="2.5" />
      <path d="M6 7h6M11 7v2.5M9 7v2" />
    </svg>
  ),
  agent: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 1L4 7h2.5L5.5 13l4-7H7L7 1z" fill="currentColor" />
    </svg>
  ),
  index: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M2 4l2-2h3l1 1h4v8H2V4z" />
    </svg>
  ),
  lock: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="3" y="6" width="8" height="6" rx="1" />
      <path d="M5 6V4.5a2 2 0 014 0V6" />
    </svg>
  ),
};

function TaskRow({ task, onCancel, onClear }: { task: Task; onCancel?: () => void; onClear?: () => void }) {
  void usePrivacy();
  const isDone = task.status === 'done';
  const isError = task.status === 'error';
  const isTerminal = isDone || isError;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 14px', borderRadius: 12,
      background: isTerminal ? 'transparent' : 'var(--et-paper)',
      border: isTerminal ? '0.5px dashed var(--et-line-2)' : '0.5px solid var(--et-line-2)',
      opacity: isDone ? 0.65 : 1,
      transition: 'transform .15s, box-shadow .2s',
    }}
    onMouseEnter={(e) => { if (!isTerminal) { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = 'var(--et-shadow-2)'; } }}
    onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{
        width: 30, height: 30, borderRadius: 8,
        background: isTerminal ? 'rgba(26,43,74,0.06)' : 'var(--et-orange-soft)',
        color: isError ? 'var(--et-orange)' : isDone ? 'var(--et-mute)' : 'var(--et-orange-2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        {isError ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 3l6 6M9 3L3 9" strokeLinecap="round" />
          </svg>
        ) : isDone ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M2.5 6.2L4.8 8.5L9.5 3.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : TASK_ICONS[task.icon]}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: isDone ? 'var(--et-mute)' : 'var(--et-ink)' }}>{maskText(task.name)}</span>
          {!isTerminal && <span className="et-num" style={{ fontSize: 11, color: 'var(--et-mute)' }}>{task.pct}%</span>}
        </div>
        {!isTerminal && (
          <div style={{ height: 4, background: 'rgba(26,43,74,0.08)', borderRadius: 999, overflow: 'hidden', marginTop: 6 }}>
            <div style={{ width: `${task.pct}%`, height: '100%', background: 'var(--et-orange)', borderRadius: 999, transition: 'width .25s' }} />
          </div>
        )}
        <div className="et-meta" style={{ fontSize: 11, marginTop: 4, color: 'var(--et-mute)' }}>{maskText(task.sub)}</div>
      </div>
      <button onClick={isTerminal ? onClear : onCancel} style={{
        all: 'unset', cursor: 'pointer', padding: '4px 10px', borderRadius: 6,
        fontSize: 11, color: isTerminal ? 'var(--et-mute)' : 'var(--et-ink)',
        border: '0.5px solid var(--et-line-2)', background: 'var(--et-paper)',
      }}>{isTerminal ? '清除' : maskText(task.action || '取消')}</button>
    </div>
  );
}

export function TaskCenterDrawer({ onClose }: { onClose: () => void }) {
  const { tasks, removeTask, clearDone } = useTaskCenter();
  const running = tasks.filter(t => t.status === 'run').length;
  const done = tasks.filter(t => t.status === 'done').length;
  const errors = tasks.filter(t => t.status === 'error').length;
  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(20,24,42,0.10)',
        backdropFilter: 'blur(2px)', zIndex: 50,
      }} />
      <div style={{
        position: 'fixed', top: 56, right: 28, zIndex: 51,
        width: 380, background: 'var(--et-paper)',
        border: '0.5px solid var(--et-line-2)',
        borderRadius: 'var(--et-r)', boxShadow: 'var(--et-shadow-3)',
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', top: -7, right: 18, width: 14, height: 14,
          background: 'var(--et-paper)',
          borderTop: '0.5px solid var(--et-line-2)',
          borderLeft: '0.5px solid var(--et-line-2)',
          transform: 'rotate(45deg)',
        }} />
        <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '0.5px solid var(--et-line)' }}>
          <div className="et-serif" style={{ fontSize: 14, fontWeight: 600, color: 'var(--et-ink)' }}>后台任务</div>
          <div className="et-meta">{running} 进行中 · {done} 已完成{errors ? ` · ${errors} 失败` : ''}</div>
        </div>
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '60vh', overflowY: 'auto' }}>
          {tasks.length === 0 && (
            <div className="et-meta" style={{ textAlign: 'center', padding: 20 }}>没有正在跑的任务。</div>
          )}
          {tasks.map(t => (
            <TaskRow key={t.id} task={t} onCancel={() => removeTask(t.id)} onClear={() => removeTask(t.id)} />
          ))}
        </div>
        <div style={{ padding: '10px 18px', borderTop: '0.5px solid var(--et-line)', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={clearDone} style={{
            all: 'unset', cursor: 'pointer', fontSize: 11, color: 'var(--et-orange)', fontWeight: 600,
          }}>清除已结束</button>
        </div>
      </div>
    </>
  );
}
