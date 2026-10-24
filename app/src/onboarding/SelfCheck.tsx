// 环境自检 — the first onboarding step. Lists what /api/diagnose found
// (微信版本 / 数据目录 / 完全磁盘访问 / 微信签名 / Frida / 捕获组件 / 密钥),
// each with a status and, where something can be done, a button.
import { useEffect, useRef, useState } from 'react';
import { getLiveKeyStatus, installFrida, openFullDiskAccess } from '../data/api';
import type { Diagnose } from '../data/api';
import { Button } from '../ui';
import { IconRefresh } from '../ui/icons';
import { blockingCount, buildChecks, routeStep, STEP_LABEL } from './flow';
import type { CheckAction, Route } from './flow';
import { CheckList, CheckListSkeleton, describeError, InlineError, Lead, Note } from './parts';

interface Props {
  diag: Diagnose | null;
  /** diagnose request in flight */
  checking: boolean;
  /** where 「继续」 goes (routeAfterCheck of `diag`) */
  route: Route | null;
  onContinue: () => void;
  onRecheck: () => void;
  onGotoData: () => void;
  onGotoAuth: () => void;
}

export function SelfCheck({ diag, checking, route, onContinue, onRecheck, onGotoData, onGotoAuth }: Props) {
  const [busy, setBusy] = useState<CheckAction | null>(null);
  const [fdaOpened, setFdaOpened] = useState(false);
  const [actionErr, setActionErr] = useState<{ code: string | null; raw: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  async function act(kind: CheckAction) {
    setActionErr(null);
    if (kind === 'recheck') return onRecheck();
    if (kind === 'goto-data') return onGotoData();
    if (kind === 'goto-auth') return onGotoAuth();
    if (kind === 'open-fda') {
      setBusy(kind);
      try {
        await openFullDiskAccess();
      } catch (e) {
        // The manual steps below still work without the deep link.
        console.warn('open-fda failed', e);
      }
      if (alive.current) { setBusy(null); setFdaOpened(true); }
      return;
    }
    if (kind === 'install-frida') {
      setBusy(kind);
      try {
        const r = await installFrida();
        if (!r.ok) {
          setActionErr({ code: r.code ?? null, raw: r.error || '' });
        } else {
          // Background pip install — wait for it, then re-run the check.
          for (let i = 0; i < 240 && alive.current; i++) {
            await new Promise(res => window.setTimeout(res, 1500));
            const s = await getLiveKeyStatus();
            if (!s.install.running) {
              if (s.install.ok === false) setActionErr({ code: 'FRIDA_MISSING', raw: s.install.log.slice(-600) });
              break;
            }
          }
          if (alive.current) onRecheck();
        }
      } catch (e) {
        setActionErr(describeError(e));
      } finally {
        if (alive.current) setBusy(null);
      }
    }
  }

  const rows = diag ? buildChecks(diag) : [];
  const blocking = blockingCount(rows);
  const warns = rows.filter(r => r.status === 'warn').length;
  const next = route ? routeStep(route) : null;
  const ready = route?.kind === 'view' && route.view === 'done';

  return (
    <>
      <Lead>
        先看一眼这台电脑的情况。有问题的项目可以直接点旁边的按钮处理，处理完点「重新检测」；也可以先继续，下一步会告诉你具体怎么做。
      </Lead>

      {diag && !checking ? <CheckList rows={rows} onAction={act} busy={busy} /> : <CheckListSkeleton rows={6} />}

      {fdaOpened && (
        <Note tone="info" label="NOTE" className="ui-mt-3">
          在系统设置里打开 Murmur 的开关后，要<strong>完全退出 Murmur（⌘Q）再重新打开</strong>，授权才会生效。
        </Note>
      )}
      {actionErr && <InlineError code={actionErr.code} raw={actionErr.raw} className="ui-mt-3" />}

      {diag && !checking && next && (
        <Note className="ob-summary" tone={blocking > 0 ? 'warning' : 'success'}
          label={blocking > 0 ? 'HOLD' : 'NEXT'}
          title={blocking > 0 ? `${blocking} 项需要处理`
            : ready ? '已经有解密好的数据'
            : warns > 0 ? `可以继续，有 ${warns} 项留意一下` : '环境没问题'}>
          {ready ? '可以直接进入 Murmur；想重新抓密钥或重新解密，点上面对应的步骤。'
            : `下一步：${STEP_LABEL[next]}。`}
        </Note>
      )}

      <div className="ob-actions ob-actions--row">
        <Button variant="primary" size="lg" onClick={onContinue} disabled={!diag || checking || !!busy}>
          {ready ? '继续：完成' : next ? `继续：${STEP_LABEL[next]}` : '继续'}
        </Button>
        <Button variant="secondary" size="lg" icon={<IconRefresh size={16} />} onClick={onRecheck}
          loading={checking} disabled={!!busy}>
          重新检测
        </Button>
      </div>
    </>
  );
}
