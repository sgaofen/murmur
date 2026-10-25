// 数据目录 step: show the WeChat accounts that were found, or help the user
// point Murmur at them (Mac: paste a path; Windows: full-disk name scan or
// paste a path). Also the Mac 完全磁盘访问 screen, which is what blocks
// this step when TCC hides ~/Library/Containers.
import { useEffect, useState } from 'react';
import { cancelDiskScan, getDiskScanStatus, saveWeChatRoot, startDiskScan } from '../data/api';
import type { Diagnose, ScanFound, ScanState } from '../data/api';
import { maskText } from '../utils/privacy';
import { Button } from '../ui';
import { IconFolder, IconRefresh, IconSearch } from '../ui/icons';
import { describeError, InlineError, Lead, March, Note, Ops, PathText, Sec } from './parts';

interface DataStepProps {
  diag: Diagnose;
  /** A folder was saved — re-run diagnose and move on. */
  onSaved: () => Promise<void> | void;
  /** Accounts are already found — go to the next step. */
  onNext: () => void;
  onRecheck: () => void;
  onOpenFda: () => void;
}

type Mode = 'auto' | 'manual' | 'scan' | 'choose';

export function DataStep({ diag, onSaved, onNext, onRecheck, onOpenFda }: DataStepProps) {
  const mac = diag.platform === 'macos';
  const found = diag.profiles.length > 0;
  const [mode, setMode] = useState<Mode>('auto');

  // Mac reaches the manual form only from the 「找到 N 个账号」 summary;
  // Windows reaches it (and the scan) from the scan / manual chooser.
  if (mode === 'manual') return <ManualPath mac={mac} onSaved={onSaved} onBack={() => setMode(mac ? 'auto' : 'choose')} />;
  if (mode === 'scan') return <DiskScan onSaved={onSaved} onBack={() => setMode('choose')} onManual={() => setMode('manual')} />;

  if (found && mode === 'auto') {
    return (
      <>
        <div className="ob-found">
          <div className="ui-big ob-found__n">{String(diag.profiles.length).padStart(2, '0')}</div>
          <div className="ob-found__meta">
            <div className="ui-label">PROFILES<b>{`找到 ${diag.profiles.length} 个微信账号`}</b></div>
            <p>Murmur 会从下面的目录读取加密数据库，解密结果只写到你这台电脑上。</p>
          </div>
        </div>
        <Sec label="PATH" title="加密数据库目录" right="READ ONLY">
          <ul className="ob-paths">
            {diag.profiles.map(p => (
              <li key={p.wxid} className="ob-path">
                <span className="ob-path__name">{maskText(p.wxid_short)}</span>
                <span className="ob-path__value"><PathText path={maskText(p.encrypted_root)} /></span>
              </li>
            ))}
          </ul>
        </Sec>
        <div className="ob-actions ob-actions--row">
          <Button variant="primary" size="lg" onClick={onNext}>下一步</Button>
          <Button variant="ghost" size="lg" icon={<IconFolder size={16} />}
            onClick={() => setMode(mac ? 'manual' : 'choose')}>
            不是这个？换一个目录
          </Button>
        </div>
      </>
    );
  }

  if (!mac) {
    return (
      <>
        <Lead>
          {found
            ? '换一个微信数据目录：可以全盘扫描，也可以直接粘贴路径。'
            : <>Murmur 已经扫了常见位置（盘根、Documents、OneDrive、注册表里微信设的路径），都没找到 <code>xwechat_files</code>。你大概率是：</>}
        </Lead>
        {!found && (
          <ul className="ob-bullets ui-mb-4">
            <li>把数据放在了非常规盘符 / 自定义文件夹里</li>
            <li>从来没在这台电脑登录过微信</li>
            <li>装的是企业微信（暂不支持）</li>
          </ul>
        )}
        <div className="ob-opts">
          <div className="ob-opt" role="button" tabIndex={0}
            onClick={() => setMode('scan')}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMode('scan'); } }}>
            <div className="ob-opt__h">
              <span className="ui-tsq">A</span>
              <span className="ob-opt__en">DISK SCAN</span>
              <IconSearch size={15} />
            </div>
            <div className="ob-opt__title">全盘扫描微信数据 <span className="ob-opt__tag">推荐 · 通常 30 秒以内</span></div>
            <div className="ob-opt__desc">
              按名字匹配扫所有本地盘，跳过 Windows、Program Files、node_modules 等无关目录。不读文件内容，不需要管理员权限。
            </div>
            <div className="ob-opt__go" aria-hidden="true">选择 →</div>
          </div>
          <div className="ob-opt" role="button" tabIndex={0}
            onClick={() => setMode('manual')}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMode('manual'); } }}>
            <div className="ob-opt__h">
              <span className="ui-tsq">B</span>
              <span className="ob-opt__en">MANUAL PATH</span>
              <IconFolder size={15} />
            </div>
            <div className="ob-opt__title">我知道路径，手动输入</div>
            <div className="ob-opt__desc">从微信「设置 → 文件管理 → 打开文件夹」复制路径粘过来。</div>
            <div className="ob-opt__go" aria-hidden="true">选择 →</div>
          </div>
        </div>
        {!found && <ScannedRoots diag={diag} />}
        {found && (
          <div className="ob-actions ob-actions--row">
            <Button variant="ghost" size="lg" onClick={() => setMode('auto')}>← 返回</Button>
          </div>
        )}
      </>
    );
  }

  // macOS, nothing found
  return (
    <>
      <Lead>Murmur 没在当前能读到的位置找到微信数据。通常是这几种情况：</Lead>
      <ul className="ob-bullets ui-mb-4">
        <li>这台 Mac 还没登录过微信，或微信还没完成首次同步</li>
        <li>macOS 权限挡住了微信容器目录，需要给 Murmur 完全磁盘访问</li>
        <li>微信数据被迁移到了自定义目录，需要手动告诉 Murmur</li>
      </ul>
      <ManualPath mac embedded onSaved={onSaved} />
      <ScannedRoots diag={diag} />
      <div className="ob-actions ob-actions--row">
        <Button variant="secondary" size="lg" icon={<IconRefresh size={15} />} onClick={onRecheck}>重新检测</Button>
        <Button variant="secondary" size="lg" onClick={onOpenFda}>打开权限设置</Button>
      </div>
    </>
  );
}

function ScannedRoots({ diag }: { diag: Diagnose }) {
  const roots = diag.wechat_search_roots ?? [];
  if (!roots.length) return null;
  return (
    <details className="ob-more">
      <summary>Murmur 已经找过的 {roots.length} 个位置</summary>
      <div className="ob-well">{roots.slice(0, 30).map(p => maskText(p)).join('\n')}</div>
    </details>
  );
}

function ManualPath({ mac, embedded, onSaved, onBack }: {
  mac: boolean;
  /** rendered inside the Mac no-data screen (no title / back button) */
  embedded?: boolean;
  onSaved: () => Promise<void> | void;
  onBack?: () => void;
}) {
  const [path, setPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [err, setErr] = useState<{ code: string | null; raw: string } | null>(null);

  async function submit() {
    const cleaned = path.trim();
    if (!cleaned) {
      setErr({ code: null, raw: '请先粘贴一个路径。' });
      return;
    }
    setSaving(true);
    setErr(null);
    setOk(null);
    try {
      const r = await saveWeChatRoot(cleaned);
      if (!r.ok) {
        setErr({ code: r.code ?? 'WECHAT_DATA_NOT_FOUND', raw: r.error || '' });
        return;
      }
      setOk(`已找到 ${r.profiles?.length || 1} 个微信账号，正在重新检测…`);
      await new Promise(res => window.setTimeout(res, 450));
      await onSaved();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {!embedded && (
        mac ? (
          <Lead>把微信数据所在的文件夹粘到下面。</Lead>
        ) : (
          <>
            <Lead>三步拿到正确路径：</Lead>
            <Ops grid className="ui-mb-3" items={[
              { t: '打开桌面版微信' },
              { t: <>左下角 <strong>三横线菜单 → 设置 → 文件管理</strong></> },
              { t: <>点「<strong>打开文件夹</strong>」—— 资源管理器地址栏里显示的就是路径</> },
              { t: <>点一下地址栏 → <kbd>Ctrl+C</kbd> 复制 → 回这里 <kbd>Ctrl+V</kbd> 粘到下面</> },
            ]} />
          </>
        )
      )}
      <Sec label="PATH" title={mac ? '手动指定微信数据位置' : '这些格式都认，多复制或少复制几层都会自动处理'} className="ui-mb-3">
        {mac ? (
          <div className="ob-muted ob-sec__text">
            可以粘贴 <code>…/xwechat_files</code>、<code>…/wxid_xxx</code>、<code>…/db_storage</code>，Murmur 会自动向上 / 向下找到正确的层级。
          </div>
        ) : (
          <div className="ob-well">{[
            'D:\\Tencent\\Weixin\\xwechat_files',
            '...\\xwechat_files\\wxid_xxx',
            '...\\xwechat_files\\wxid_xxx\\db_storage',
            '...\\session\\session.db',
          ].join('\n')}</div>
        )}
      </Sec>
      <label className="ob-label" htmlFor="ob-wechat-root">微信数据路径</label>
      <div className="ob-field">
        <span className="ob-field__p" aria-hidden="true">PATH</span>
        <input
          id="ob-wechat-root"
          className="ob-input"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={mac
            ? '~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files'
            : '粘到这里，不用清理多余的引号 / 反斜杠'}
          spellCheck={false}
          autoComplete="off"
          data-autofocus={embedded ? undefined : true}
          onKeyDown={(e) => { if (e.key === 'Enter' && !saving) void submit(); }}
        />
      </div>
      {ok && <div className="ob-field-msg is-ok">{ok}</div>}
      {err && <InlineError code={err.code} raw={err.raw} className="ui-mt-2" />}
      <div className="ob-actions ob-actions--row">
        <Button variant="primary" size="lg" onClick={() => void submit()} loading={saving}>
          {saving ? '正在检查…' : '保存路径并重新检测'}
        </Button>
        {onBack && <Button variant="ghost" size="lg" onClick={onBack}>← 返回</Button>}
      </div>
    </>
  );
}

function DiskScan({ onSaved, onBack, onManual }: { onSaved: () => Promise<void> | void; onBack: () => void; onManual: () => void }) {
  const [state, setState] = useState<ScanState | null>(null);
  const [stage, setStage] = useState<'starting' | 'scanning' | 'done' | 'error'>('starting');
  const [savingPath, setSavingPath] = useState<string | null>(null);
  const [err, setErr] = useState<{ code: string | null; raw: string } | null>(null);
  // Bumped by 「重新扫描」 to start a fresh scan via the effect below.
  const [scanEpoch, setScanEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    setStage('starting');
    setState(null);
    setErr(null);

    const poll = async () => {
      try {
        const s = await getDiskScanStatus();
        if (cancelled) return;
        setState(s);
        if (!s.running) {
          setStage(s.error ? 'error' : 'done');
          return;
        }
        timer = window.setTimeout(poll, 600);
      } catch (e) {
        if (cancelled) return;
        setErr(describeError(e));
        setStage('error');
      }
    };

    (async () => {
      try {
        const initial = await startDiskScan({});
        if (cancelled) return;
        setState(initial);
        setStage('scanning');
        timer = window.setTimeout(poll, 600);
      } catch (e) {
        if (cancelled) return;
        setErr(describeError(e));
        setStage('error');
      }
    })();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [scanEpoch]);

  async function pick(f: ScanFound) {
    setSavingPath(f.path);
    setErr(null);
    try {
      const r = await saveWeChatRoot(f.path);
      if (!r.ok) {
        setErr({ code: r.code ?? null, raw: r.error || '' });
        setSavingPath(null);
        return;
      }
      await new Promise(res => window.setTimeout(res, 350));
      await onSaved();
    } catch (e) {
      setErr(describeError(e));
      setSavingPath(null);
    }
  }

  async function cancel() {
    try { await cancelDiskScan(); } catch { /* the scan stops on its own */ }
    onBack();
  }

  const found = state?.found ?? [];
  const elapsed = state?.started_at
    ? Math.max(0, (state.finished_at ?? Math.floor(Date.now() / 1000)) - state.started_at) : 0;

  return (
    <>
      <div className="ob-scan">
        <div className="ob-scan__read">
          <div>
            <div className="ui-label">DRIVES<b>盘</b></div>
            <div className="ob-scan__v">{state?.drives_done ?? 0}<small> / {state?.drives_total ?? 0}</small></div>
          </div>
          <div>
            <div className="ui-label">DIRS<b>已查目录</b></div>
            <div className="ob-scan__v">{(state?.dirs_scanned ?? 0).toLocaleString()}</div>
          </div>
          <div>
            <div className="ui-label">FOUND<b>候选</b></div>
            <div className="ob-scan__v">{found.length}</div>
          </div>
        </div>
        {(stage === 'starting' || stage === 'scanning') && <March className="ui-mt-3" />}
        <div className="ob-scan-status">
          {stage === 'starting' && '正在启动扫描…'}
          {stage === 'scanning' && `扫描中 · ${state?.drives_done ?? 0}/${state?.drives_total ?? 0} 个盘完成`}
          {stage === 'done' && `扫描完成 · 耗时 ${elapsed} 秒 · 找到 ${found.length} 个候选`}
          {stage === 'error' && '扫描失败'}
        </div>
        {stage === 'scanning' && (
          <>
            <div className="ob-muted ui-mt-2">还在扫，等所有盘都完成再下结论 —— 找到的候选会陆续出现在下面。</div>
            {state?.current_path && <div className="ob-scan-path">{maskText(state.current_path)}</div>}
          </>
        )}
      </div>

      {stage === 'error' && (state?.error || err) && (
        <InlineError code={err?.code} raw={state?.error || err?.raw} className="ui-mt-3" />
      )}
      {stage !== 'error' && err && <InlineError code={err.code} raw={err.raw} className="ui-mt-3" />}

      {found.length > 0 && (
        <Sec label="FOUND" title={`点一个候选就用它（找到 ${found.length} 个）：`}>
          <ul className="ob-paths">
            {found.map(f => (
              <li key={f.path}>
                <button type="button" className="ob-path" onClick={() => void pick(f)}
                  disabled={savingPath !== null}>
                  <span className="ob-path__name">{f.kind === 'wxid' ? '账号' : '数据根'}</span>
                  <span className="ob-path__value"><PathText path={maskText(f.path)} /></span>
                  <span className="ob-path__go" aria-hidden="true">{savingPath === f.path ? '…' : '用这个 →'}</span>
                </button>
              </li>
            ))}
          </ul>
        </Sec>
      )}

      {stage === 'done' && found.length === 0 && (
        <Note tone="warning" label="EMPTY" title="扫完了，没有候选" className="ui-mt-3">
          可能这台电脑从来没登录过微信，或者数据藏在 Murmur 默认跳过的目录里（<code>Windows\</code>、<code>Program Files\</code>、<code>node_modules\</code>、<code>$Recycle.Bin\</code> 等），也可能装的是企业微信（暂不支持）。<strong>「手动输入路径」可以绕过所有跳过规则。</strong>
        </Note>
      )}

      <div className="ob-actions ob-actions--row">
        {(stage === 'starting' || stage === 'scanning') && (
          <Button variant="secondary" size="lg" onClick={() => void cancel()}>取消</Button>
        )}
        {(stage === 'done' || stage === 'error') && (
          <>
            <Button variant="secondary" size="lg" onClick={onBack}>返回</Button>
            <Button variant="secondary" size="lg" icon={<IconRefresh size={16} />}
              onClick={() => setScanEpoch(n => n + 1)} disabled={savingPath !== null}>
              重新扫描
            </Button>
            {found.length === 0 && <Button variant="primary" size="lg" onClick={onManual}>手动输入路径</Button>}
          </>
        )}
      </div>
    </>
  );
}

/** Mac: TCC blocks reading the WeChat container. */
export function FdaStep({ onOpenSettings, onRetry, retrying }: { onOpenSettings: () => void; onRetry: () => void; retrying?: boolean }) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <Lead>
        macOS 出于隐私保护，不让普通 App 直接读 <code>~/Library/Containers/</code> 里其他 App 的数据。
        Murmur 要读这台电脑上的微信加密数据库，需要你手动给一次「<strong>完全磁盘访问</strong>」权限。
      </Lead>
      <Sec label="STEPS" title="3 步搞定" right="约 30 秒">
        <Ops grid items={[
          { t: <>点下面「<strong>打开系统设置</strong>」，会直接跳到「完全磁盘访问」面板</> },
          { t: <>找到 <strong>Murmur</strong>，把右边的开关打开（没列出来就点 <strong>+</strong> 选 <code>/Applications/Murmur.app</code>）</> },
          { t: <>授权后<strong>完全退出 Murmur 再重新打开</strong>（macOS 要重启进程才生效）</> },
        ]} />
      </Sec>
      <Note tone="info" label="WHY" className="ui-mt-3">
        这是 macOS 的硬性要求，任何读微信数据的 Mac 工具都要过这一步；只需要授权这一次。
      </Note>
      <div className="ob-actions ob-actions--row">
        <Button variant="primary" size="lg" onClick={() => { setOpened(true); onOpenSettings(); }}>
          打开系统设置 → 完全磁盘访问
        </Button>
        <Button variant={opened ? 'secondary' : 'ghost'} size="lg" onClick={onRetry} loading={retrying}>
          我已经授权并重启过了 —— 重新检测
        </Button>
      </div>
    </>
  );
}
