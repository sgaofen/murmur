// 授权/重签 and 取得密钥 screens. MacKeyChoice is shared with the
// 「读取密钥」 dialog: on WeChat 4.1.9+ it leads with live capture (whose own
// chooser offers Frida / 免 Frida), otherwise with the memory scan.
import { useState } from 'react';
import type { Diagnose } from '../data/api';
import { Button, Callout, Card } from '../ui';
import { IconRefresh } from '../ui/icons';
import { buildChecks, liveRecommended } from './flow';
import { CheckList, InlineError, Lead } from './parts';

// ———————————————————————— Mac: 授权/重签 ————————————————————————

export function AuthStep({ diag, onResign, onNext, onPaste, onLive, onOpenFda }: {
  diag: Diagnose;
  onResign: () => void;
  onNext: () => void;
  onPaste: () => void;
  onLive: () => void;
  onOpenFda: () => void;
}) {
  const rows = buildChecks(diag)
    .filter(r => r.id === 'fda' || r.id === 'sign')
    .map(r => (r.id === 'fda' ? r : { ...r, action: undefined }));
  const signed = diag.capabilities.wechat_hardened === false;
  const liveFirst = liveRecommended(diag);

  return (
    <>
      <CheckList rows={rows} onAction={k => { if (k === 'open-fda') onOpenFda(); }} />

      {signed ? (
        <>
          <Callout tone="success" className="ui-mt-4" title="微信已经重签过（ad-hoc），这一步不用再做">
            微信自己升级后签名会被重置回默认的加固状态，到时候回来重做这一步就行。
          </Callout>
          <div className="ob-actions">
            <Button variant="primary" size="lg" block onClick={onNext}>下一步：取得密钥</Button>
            <Button variant="ghost" block icon={<IconRefresh size={15} />} onClick={onResign}>再重签一次</Button>
          </div>
        </>
      ) : (
        <>
          <Lead className="ui-mt-4">
            macOS 默认给微信加了 <strong>hardened runtime</strong> 标记，系统会拒绝任何调试器附加 ——
            所以内存扫描和 Frida 实时抓取都拿不到密钥。不用关 SIP 的办法：<strong>给微信主程序重新做一次 ad-hoc 签名</strong>。
          </Lead>
          <Card variant="sunken" padding="sm">
            <div className="ob-section-title">点「开始重签名」后，我会做这几件事：</div>
            <ol className="ob-list">
              <li>自动退出微信（先发 quit，再 pkill 兜底）</li>
              <li>弹出 macOS 系统认证窗口 —— <strong>输入开机密码</strong></li>
              <li>对微信主程序做 <code>codesign --remove-signature</code> + 重新 ad-hoc 签名</li>
              <li>重新打开微信，<strong>停在这里等你下一步</strong>，不会自动开始抓密钥</li>
            </ol>
          </Card>
          <Callout tone="success" compact className="ui-mt-3">
            重签名完成后，下一页是「扫码登录 + 点开几个对话」，<strong>没有时间限制</strong>，慢慢来 —— 你点了按钮我才开始抓密钥。
          </Callout>
          <Callout tone="warning" compact className="ui-mt-2">
            重签名属于「修改 App」操作。微信自己升级时会把签名重置回原样，不影响后续使用。如果不想动微信，下面有其他办法。<br />
            <strong>风控提示：</strong>重签名、挂钩微信进程这类操作有被腾讯检测到的可能，极端情况下可能触发账号安全提醒或限制。
            Murmur 只读取你这台电脑上你自己的聊天数据，不上传任何内容；介意的话请不要继续。
          </Callout>
          <div className="ob-actions">
            <Button variant="primary" size="lg" block onClick={onResign}>开始重签名</Button>
            {liveFirst && (
              <Button variant="secondary" size="lg" block onClick={onLive}>
                先不重签：用免 Frida 方式取得密钥
              </Button>
            )}
            <Button variant="ghost" block onClick={onPaste}>不用，我手动粘贴密钥</Button>
          </div>
        </>
      )}
    </>
  );
}

// ———————————————————————— Mac: 取得密钥 ————————————————————————

function ScanPrep() {
  return (
    <>
      <Card variant="sunken" padding="sm">
        <div className="ob-section-title">开始前请先做完这几步：</div>
        <ol className="ob-list">
          <li><strong>微信已经登录</strong>（不是登录界面，是已经能看到消息列表）</li>
          <li><strong>点开 3–5 个对话</strong>、翻一下朋友圈 —— 让微信把每个数据库的 key 放进内存；不点开，抓到的 key 会少</li>
          <li>微信别关，继续开着</li>
        </ol>
      </Card>
      <Callout tone="warning" compact className="ui-mt-3">
        点开始后 30 秒内会弹一次 macOS 系统密码窗口，输入开机密码后立刻开扫；这个过程不会关闭微信。
      </Callout>
    </>
  );
}

export interface MacKeyChoiceProps {
  version?: string | null;
  /** WeChat 4.1.9+: lead with live capture. */
  liveFirst: boolean;
  /** WeChat still has hardened runtime: memory scan / Frida need a re-sign first. */
  hardened?: boolean;
  onScan: () => void;
  onLive: () => void;
  onPaste?: () => void;
  onResign?: () => void;
}

export function MacKeyChoice({ version, liveFirst, hardened, onScan, onLive, onPaste, onResign }: MacKeyChoiceProps) {
  return (
    <>
      {hardened && (
        <Callout tone="warning" compact className="ui-mb-3" title="微信还是默认的加固签名"
          actions={onResign && <Button size="sm" onClick={onResign}>去重签名</Button>}>
          内存扫描和 Frida 方式要先重签名{onResign ? '' : '（在初始化引导的「授权/重签」一步）'}；免 Frida 方式（私有副本）不需要。
        </Callout>
      )}
      {liveFirst ? (
        <>
          <Callout tone="accent" title={`检测到微信 ${version || '4.1.9+'}：推荐用「实时抓取」`}
            actions={<Button variant="primary" size="lg" block onClick={onLive}>用实时抓取（推荐）</Button>}>
            4.1.9 之后密钥不再常驻内存，内存扫描大概率一个都抓不到。实时抓取会在你用微信时把密钥截下来，大约 1–2 分钟；下一步可以选{' '}
            <strong>Frida</strong> 或 <strong>免 Frida（私有副本）</strong>两种方式。
          </Callout>
          <details className="ob-more">
            <summary>或者：先试试内存扫描（4.1.9 以前的微信用这个）</summary>
            <ScanPrep />
            <div className="ob-actions">
              <Button variant="secondary" size="lg" block onClick={onScan}>
                先试试内存扫描（抓不到会自动切到实时抓取）
              </Button>
            </div>
          </details>
          {onPaste && (
            <div className="ob-actions">
              <Button variant="ghost" block onClick={onPaste}>或者：手动粘贴密钥</Button>
            </div>
          )}
        </>
      ) : (
        <>
          <ScanPrep />
          <div className="ob-actions">
            <Button variant="primary" size="lg" block onClick={onScan}>微信已就绪 → 开始抓取</Button>
            <Button variant="secondary" size="lg" block onClick={onLive}>微信 4.1.9 及以上？直接用「实时抓取」</Button>
            {onPaste && <Button variant="ghost" block onClick={onPaste}>或者：手动粘贴密钥</Button>}
          </div>
        </>
      )}
    </>
  );
}

export function MacKeyStep({ diag, onScan, onLive, onPaste, onResign }: {
  diag: Diagnose; onScan: () => void; onLive: () => void; onPaste: () => void; onResign: () => void;
}) {
  const liveFirst = liveRecommended(diag);
  return (
    <>
      {!liveFirst && <Lead>我会附加到微信进程扫内存，抓 SQLCipher 密钥。</Lead>}
      <MacKeyChoice version={diag.wechat_version} liveFirst={liveFirst}
        hardened={diag.capabilities.wechat_hardened === true}
        onScan={onScan} onLive={onLive} onPaste={onPaste} onResign={onResign} />
    </>
  );
}

/** After a successful re-sign: WeChat was relaunched, log in, then capture. */
export function MacWaitLogin({ diag, onScan, onLive }: { diag: Diagnose | null; onScan: () => void; onLive: () => void }) {
  const liveFirst = liveRecommended(diag);
  return (
    <>
      <Callout tone="success" title="重签名成功，微信已经重新打开" />
      <Card variant="sunken" padding="sm" className="ui-mt-3">
        <div className="ob-section-title">下一步要做的（不急，慢慢来）：</div>
        <ol className="ob-list">
          <li>到微信窗口，<strong>用手机扫码登录</strong></li>
          <li>等左边联系人列表加载完，<strong>点开 3–5 个对话</strong>，每个滑两下</li>
          <li>顺手翻一下朋友圈 / 收藏 / 联系人页</li>
          <li>都做完再回来点下面的按钮 —— <strong>不需要赶时间</strong></li>
        </ol>
      </Card>
      <Callout tone="info" compact className="ui-mt-3">
        为什么要点开对话？微信是「点到哪个库才解锁哪个库」，没点开的库密钥不在内存里，抓出来会缺几个库。点按钮后会弹密码窗口（扫内存要管理员权限），输完就开始扫。
      </Callout>
      {liveFirst ? (
        <>
          <Callout tone="accent" className="ui-mt-3" title={`检测到微信 ${diag?.wechat_version || '4.1.9+'}：推荐用「实时抓取」`}
            actions={<Button variant="primary" size="lg" block onClick={onLive}>用实时抓取（推荐）</Button>}>
            4.1.9 之后密钥不再常驻内存，内存扫描大概率一个都抓不到。实时抓取大约 1–2 分钟。
          </Callout>
          <div className="ob-actions">
            <Button variant="secondary" size="lg" block onClick={onScan}>
              微信都准备好了 → 先试试内存扫描（抓不到会自动切到实时抓取）
            </Button>
          </div>
        </>
      ) : (
        <div className="ob-actions">
          <Button variant="primary" size="lg" block onClick={onScan}>微信都准备好了 → 开始抓密钥</Button>
          <Button variant="secondary" size="lg" block onClick={onLive}>微信 4.1.9 及以上？直接用「实时抓取」</Button>
        </div>
      )}
    </>
  );
}

export function MacPasteKey({ diag, onSubmit, onLive }: { diag: Diagnose; onSubmit: (key: string) => void; onLive: () => void }) {
  const [key, setKey] = useState('');
  const cleaned = key.trim().toLowerCase();
  const valid = cleaned.length === 64 && /^[0-9a-f]+$/.test(cleaned);
  const sipOn = diag.capabilities.sip_enabled === true;
  return (
    <>
      <Lead>
        {sipOn
          ? <>Mac 默认开着 <strong>SIP（系统完整性保护）</strong>，没法自动从微信进程内存抓密钥。下面三种办法都能拿到 64 位 SQLCipher 密钥，任选一个：</>
          : <>把 64 位 SQLCipher 密钥粘进来，解密在你这台 Mac 上跑。</>}
      </Lead>
      <Card variant="sunken" padding="sm">
        <ol className="ob-list">
          <li>
            <strong>有 Windows 电脑（最快）</strong>
            <div className="ob-muted">
              在 Windows 上 <code>git clone</code> 这个仓库 → 运行 <code>start-windows.bat</code>。引导跑完后，密钥在 <code>~/.murmur/config.json</code> 的 <code>decrypt_key</code> 字段，拷过来粘到下面。
            </div>
          </li>
          <li>
            <strong>关掉 Mac 的 SIP（一次性）</strong>
            <div className="ob-muted">
              重启进恢复模式（开机长按电源键）→ 终端运行 <code>csrutil disable</code> → 重启 → 在仓库根目录运行：
            </div>
            <div className="ob-well">sudo python3 cli/extract_key_mac.py</div>
            <div className="ob-muted">密钥会打印在终端里。注意：关 SIP 是系统级操作，请权衡。</div>
          </li>
          <li>
            <strong>借朋友的 Windows 跑一次</strong>
            <div className="ob-muted">
              在朋友的 Windows 上短时间登录你的微信 → 跑 <code>cli/extract_key_dll.py</code> → 拷密钥回来。同一个微信账号，密钥相同。
            </div>
          </li>
        </ol>
      </Card>
      <label className="ob-label ui-mt-4" htmlFor="ob-paste-key">解密密钥</label>
      <input
        id="ob-paste-key"
        className={`ob-input${valid ? ' is-valid' : ''}`}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="把 64 位十六进制密钥粘到这里"
        spellCheck={false}
        autoComplete="off"
      />
      <div className={`ob-field-msg${valid ? ' is-ok' : ''}`}>
        {key ? (valid ? '格式正确（64 位十六进制）' : `${cleaned.length} / 64 位十六进制`) : '只包含 0–9 和 a–f，共 64 个字符'}
      </div>
      <div className="ob-actions">
        <Button variant="primary" size="lg" block disabled={!valid} onClick={() => onSubmit(key)}>解密并进入</Button>
        <Button variant="ghost" block onClick={onLive}>改用实时抓取</Button>
      </div>
    </>
  );
}

// ———————————————————————— Windows: 取得密钥 ————————————————————————

export function WinKeyStep({ diag, onStart, onRecheck, rechecking }: {
  diag: Diagnose; onStart: () => void; onRecheck: () => void; rechecking?: boolean;
}) {
  const running = diag.capabilities.weixin_running !== false;
  return (
    <>
      <Lead>Windows 抓密钥要卡准登录那一刻，请按这个顺序做：</Lead>
      <Card variant="sunken" padding="sm">
        <ol className="ob-list">
          <li>先在微信里<strong>退出登录</strong>，让微信停在登录页；<strong>不要关闭微信程序</strong></li>
          <li>回到 Murmur，点下面的「开始抓密钥」—— 我会把 hook 装到当前微信进程</li>
          <li>看到「等待登录事件」后，立刻回微信点<strong>登录 / 扫码登录</strong></li>
          <li>读到密钥后会马上解密全部数据，然后进入 Murmur</li>
        </ol>
      </Card>
      <Callout tone="warning" compact className="ui-mt-3">
        关键：先停在登录页，再点开始，最后去微信登录。一直保持已登录，hook 抓不到登录那一瞬间的密钥。
      </Callout>
      {!running && (
        <>
          <InlineError code="WECHAT_NOT_RUNNING" className="ui-mt-3" />
          <div className="ob-muted ui-mt-2">Murmur 每 2.5 秒会自动重新检测一次。</div>
        </>
      )}
      <div className="ob-actions">
        <Button variant="primary" size="lg" block disabled={!running} onClick={onStart}>开始抓密钥</Button>
        {!running && (
          <Button variant="secondary" size="lg" block icon={<IconRefresh size={16} />} loading={rechecking} onClick={onRecheck}>
            再次检测微信
          </Button>
        )}
      </div>
    </>
  );
}
