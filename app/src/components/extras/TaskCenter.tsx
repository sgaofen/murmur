import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { maskText } from '../../utils/privacy';
import { usePrivacy } from '../../utils/usePrivacy';
import { cx } from '../../ui';
import './TaskCenter.css';

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

// ─── Bell / key ───
/** Opens the task drawer; shows how many tasks are running. Looks like an
 * instrument key: `[T] 任务 2`. */
export function TaskCenterBell({ onClick, active }: { onClick: () => void; active: boolean }) {
  const { tasks } = useTaskCenter();
  const count = tasks.filter(t => t.status === 'run').length;
  return (
    <button type="button" onClick={onClick} title="后台任务" aria-expanded={active}
      className={cx('ui-btn', 'ui-btn--secondary', 'ui-btn--sm', 'ui-btn--kbd', 'tc-key', active && 'is-open')}>
      <kbd className="ui-kbd" aria-hidden="true">T</kbd>
      <span className="ui-btn__label">任务</span>
      <span className={cx('tc-key__n', count > 0 && 'is-run')}>{count > 0 ? count : '0'}</span>
    </button>
  );
}

// ─── Drawer ───
const STATUS_LABEL: Record<TaskStatus, string> = { run: 'RUN', done: 'DONE', error: 'FAIL' };

function TaskRow({ task, onCancel, onClear }: { task: Task; onCancel?: () => void; onClear?: () => void }) {
  void usePrivacy();
  const isTerminal = task.status === 'done' || task.status === 'error';
  const segs = 24;
  const lit = Math.round((task.pct / 100) * segs);
  return (
    <div className={cx('tc-row', `is-${task.status}`)}>
      <div className="tc-row__top">
        <span className="tc-row__state">
          <i className={cx('ui-led', task.status === 'done' && 'is-off', task.status === 'error' && 'ui-led--error', task.status === 'run' && 'is-pulse')} aria-hidden="true" />
          {STATUS_LABEL[task.status]}
        </span>
        <span className="tc-row__name">{maskText(task.name)}</span>
        {!isTerminal && <span className="tc-row__pct">{task.pct}%</span>}
        <button type="button" className="tc-row__btn" onClick={isTerminal ? onClear : onCancel}
          title={isTerminal ? '清除这条记录' : '只隐藏这条任务，不会中止后台进程'}>
          {isTerminal ? '清除' : maskText(task.action || '隐藏')}
        </button>
      </div>
      {!isTerminal && (
        <div className="tc-row__bar" aria-hidden="true">
          {Array.from({ length: segs }, (_, i) => <i key={i} className={cx(i < lit && 'on')} />)}
        </div>
      )}
      <div className="tc-row__sub">{maskText(task.sub)}</div>
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
      <div className="tc-scrim" onClick={onClose} />
      <div className="tc-drawer" role="dialog" aria-label="后台任务">
        <div className="tc-drawer__head">
          <span className="ui-mod__id">T</span>
          <span className="ui-mod__title">后台任务</span>
          <span>TASKS</span>
          <span className="tc-drawer__count">RUN {running} · DONE {done}{errors ? ` · FAIL ${errors}` : ''}</span>
        </div>
        <div className="tc-drawer__list">
          {tasks.length === 0 && <div className="tc-drawer__empty">没有正在跑的任务。</div>}
          {tasks.map(t => (
            <TaskRow key={t.id} task={t} onCancel={() => removeTask(t.id)} onClear={() => removeTask(t.id)} />
          ))}
        </div>
        <div className="tc-drawer__foot">
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={clearDone}>清除已结束</button>
        </div>
      </div>
    </>
  );
}
