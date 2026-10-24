// 授权/重签 and 取得密钥 screens. MacKeyChoice is shared with the
// 「读取密钥」 dialog: on WeChat 4.1.9+ it leads with live capture (whose own
// chooser offers Frida / 免 Frida), otherwise with the memory scan.
import { useState } from 'react';
import type { Diagnose } from '../data/api';
import { Button } from '../ui';
import { IconRefresh } from '../ui/icons';
import { buildChecks, liveRecommended, privateCopyShortcut } from './flow';
import { CheckList, InlineError, Lead, Note, Ops, Sec } from './parts';

// ———————————————————————— Mac: 授权/重签 ————————————————————————

export function AuthStep({ diag, onResign, onNext, onPaste, onPrivateCopy, onOpenFda }: {
  diag: Diagnose;
  onResign: () => void;
  onNext: () => void;
  onPaste: () => void;
  /** Skip the re-sign: open 实时抓取 directly on the 免 Frida (private copy) method. */
  onPrivateCopy: () => void;
  onOpenFda: () => void;
}) {
  const rows = buildChecks(diag)
    .filter(r => r.id === 'fda' || r.id === 'sign')
    .map(r => (r.id === 'fda' ? r : { ...r, action: undefined }));
  const signed = diag.capabilities.wechat_hardened === false;
  // The Frida-free way needs no re-sign — but only if the capture dylib shipped.
  const skipResign = liveRecommended(diag) && privateCopyShortcut(diag);

  return (
    <>
      <CheckList rows={rows} onAction={k => { if (k === 'open-fda') onOpenFda(); }} />

      {signed ? (
        <>
          <Note tone="success" label="PASS" className="ui-mt-4" title="微信已经重签过（ad-hoc），这一步不用再做">
            微信自己升级后签名会被重置回默认的加固状态，到时候回来重做这一步就行。
          </Note>
          <div className="ob-actions ob-actions--row">
            <Button variant="primary" size="lg" onClick={onNext}>下一步：取得密钥</Button>
            <Button variant="ghost" size="lg" icon={<IconRefresh size={15} />} onClick={onResign}>再重签一次</Button>
          </div>
        </>
      ) : (
        <>
          <Lead className="ui-mt-4">
            macOS 默认给微信加了 <strong>hardened runtime</strong> 标记，系统会拒绝任何调试器附加 ——
            所以内存扫描和 Frida 实时抓取都拿不到密钥。不用关 SIP 的办法：<strong>给微信主程序重新做一次 ad-hoc 签名</strong>。
          </Lead>
          {/* The risk note sits before the procedure so it is read before the button. */}
          <Note tone="warning" label="RISK">
            重签名属于「修改 App」操作。微信自己升级时会把签名重置回原样，不影响后续使用。如果不想动微信，下面有其他办法。<br />
            <strong>风控提示：</strong>重签名、挂钩微信进程这类操作有被腾讯检测到的可能，极端情况下可能触发账号安全提醒或限制。
            Murmur 只读取你这台电脑上你自己的聊天数据，不上传任何内容；介意的话请不要继续。
          </Note>
          <Sec label="DOES" title="点「开始重签名」后，我会做这几件事：">
            <Ops items={[
              '自动退出微信（先发 quit，再 pkill 兜底）',
              <>弹出 macOS 系统认证窗口 —— <strong>输入开机密码</strong></>,
              <>对微信主程序做 <code>codesign --remove-signature</code> + 重新 ad-hoc 签名</>,
              <>重新打开微信，<strong>停在这里等你下一步</strong>，不会自动开始抓密钥</>,
            ]} />
          </Sec>
          <Note tone="success" label="NEXT" className="ui-mt-4">
            重签名完成后，下一页是「扫码登录 + 点开几个对话」，<strong>没有时间限制</strong>，慢慢来 —— 你点了按钮我才开始抓密钥。
          </Note>
          <div className="ob-actions ob-actions--row">
            <Button variant="primary" size="lg" onClick={onResign}>开始重签名</Button>
            {skipResign && (
              <Button variant="secondary" size="lg" onClick={onPrivateCopy}>
                先不重签：用免 Frida 方式取得密钥
              </Button>
            )}
            <Button variant="ghost" size="lg" onClick={onPaste}>不用，我手动粘贴密钥</Button>
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
      <Sec label="PREP" title="开始前请先做完这几步：">
        <Ops items={[
          <><strong>微信已经登录</strong>（不是登录界面，是已经能看到消息列表）</>,
          <><strong>点开 3–5 个对话</strong>、翻一下朋友圈 —— 让微信把每个数据库的 key 放进内存；不点开，抓到的 key 会少</>,
          '微信别关，继续开着',
        ]} />
      </Sec>
      <Note tone="warning" label="AUTH" className="ui-mt-3">
        点开始后 30 秒内会弹一次 macOS 系统密码窗口，输入开机密码后立刻开扫；这个过程不会关闭微信。
      </Note>
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
        <Note tone="warning" label="SIGN" className="ui-mb-4" title="微信还是默认的加固签名"
          actions={onResign && <Button size="sm" onClick={onResign}>去重签名</Button>}>
          内存扫描和 Frida 方式要先重签名{onResign ? '' : '（在初始化引导的「授权/重签」一步）'}；免 Frida 方式（私有副本）不需要。
        </Note>
      )}
      {liveFirst ? (
        <>
          <div className="ob-reco">
            <div className="ob-reco__h">
              <span className="ui-label">RECOMMENDED<b>推荐</b></span>
              <span className="ob-reco__ver">WECHAT {version || '4.1.9+'}</span>
            </div>
            <div className="ob-reco__title">{`检测到微信 ${version || '4.1.9+'}：推荐用「实时抓取」`}</div>
            <p className="ob-reco__body">
              4.1.9 之后密钥不再常驻内存，内存扫描大概率一个都抓不到。实时抓取会在你用微信时把密钥截下来，大约 1–2 分钟；下一步可以选{' '}
              <strong>Frida</strong> 或 <strong>免 Frida（私有副本）</strong>两种方式。
            </p>
            <div className="ob-actions ob-actions--row">
              <Button variant="primary" size="lg" onClick={onLive}>用实时抓取（推荐）</Button>
              {onPaste && <Button variant="ghost" size="lg" onClick={onPaste}>或者：手动粘贴密钥</Button>}
            </div>
          </div>
          <details className="ob-more">
            <summary>或者：先试试内存扫描（4.1.9 以前的微信用这个）</summary>
            <ScanPrep />
            <div className="ob-actions ob-actions--row">
              <Button variant="secondary" size="lg" onClick={onScan}>
                先试试内存扫描（抓不到会自动切到实时抓取）
              </Button>
            </div>
          </details>
        </>
      ) : (
        <>
          <ScanPrep />
          <div className="ob-actions ob-actions--row">
            <Button variant="primary" size="lg" onClick={onScan}>微信已就绪 → 开始抓取</Button>
            <Button variant="secondary" size="lg" onClick={onLive}>微信 4.1.9 及以上？直接用「实时抓取」</Button>
            {onPaste && <Button variant="ghost" size="lg" onClick={onPaste}>或者：手动粘贴密钥</Button>}
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
      <Note tone="success" label="PASS" title="重签名成功，微信已经重新打开" />
      <Sec label="TODO" title="下一步要做的（不急，慢慢来）：">
        <Ops grid items={[
          { t: <>到微信窗口，<strong>用手机扫码登录</strong></> },
          { t: <>等左边联系人列表加载完，<strong>点开 3–5 个对话</strong>，每个滑两下</> },
          { t: '顺手翻一下朋友圈 / 收藏 / 联系人页' },
          { t: <>都做完再回来点下面的按钮 —— <strong>不需要赶时间</strong></> },
        ]} />
      </Sec>
      <Note tone="info" label="WHY" className="ui-mt-3">
        为什么要点开对话？微信是「点到哪个库才解锁哪个库」，没点开的库密钥不在内存里，抓出来会缺几个库。点按钮后会弹密码窗口（扫内存要管理员权限），输完就开始扫。
      </Note>
      {liveFirst ? (
        <>
          <div className="ob-reco ui-mt-4">
            <div className="ob-reco__h">
              <span className="ui-label">RECOMMENDED<b>推荐</b></span>
              <span className="ob-reco__ver">WECHAT {diag?.wechat_version || '4.1.9+'}</span>
            </div>
            <div className="ob-reco__title">{`检测到微信 ${diag?.wechat_version || '4.1.9+'}：推荐用「实时抓取」`}</div>
            <p className="ob-reco__body">4.1.9 之后密钥不再常驻内存，内存扫描大概率一个都抓不到。实时抓取大约 1–2 分钟。</p>
            <div className="ob-actions ob-actions--row">
              <Button variant="primary" size="lg" onClick={onLive}>用实时抓取（推荐）</Button>
            </div>
          </div>
          <div className="ob-actions ob-actions--row">
            <Button variant="secondary" size="lg" onClick={onScan}>
              微信都准备好了 → 先试试内存扫描（抓不到会自动切到实时抓取）
            </Button>
          </div>
        </>
      ) : (
        <div className="ob-actions ob-actions--row">
          <Button variant="primary" size="lg" onClick={onScan}>微信都准备好了 → 开始抓密钥</Button>
          <Button variant="secondary" size="lg" onClick={onLive}>微信 4.1.9 及以上？直接用「实时抓取」</Button>
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
      <Ops items={[
        {
          t: '有 Windows 电脑（最快）',
          d: <>在 Windows 上 <code>git clone</code> 这个仓库 → 运行 <code>start-windows.bat</code>。引导跑完后，密钥在 <code>~/.murmur/config.json</code> 的 <code>decrypt_key</code> 字段，拷过来粘到下面。</>,
        },
        {
          t: '关掉 Mac 的 SIP（一次性）',
          d: (
            <>
              重启进恢复模式（开机长按电源键）→ 终端运行 <code>csrutil disable</code> → 重启 → 在仓库根目录运行：
              <div className="ob-well">sudo python3 cli/extract_key_mac.py</div>
              密钥会打印在终端里。注意：关 SIP 是系统级操作，请权衡。
            </>
          ),
        },
        {
          t: '借朋友的 Windows 跑一次',
          d: <>在朋友的 Windows 上短时间登录你的微信 → 跑 <code>cli/extract_key_dll.py</code> → 拷密钥回来。同一个微信账号，密钥相同。</>,
        },
      ]} />
      <label className="ob-label ui-mt-4" htmlFor="ob-paste-key">解密密钥</label>
      <div className={`ob-field${valid ? ' is-valid' : ''}`}>
        <span className="ob-field__p" aria-hidden="true">KEY</span>
        <input
          id="ob-paste-key"
          className="ob-input"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="把 64 位十六进制密钥粘到这里"
          spellCheck={false}
          autoComplete="off"
        />
        <span className="ob-field__r" aria-hidden="true">{valid ? '✓ 64 HEX' : '64 HEX'}</span>
      </div>
      <div className={`ob-field-msg${valid ? ' is-ok' : ''}`}>
        {key ? (valid ? '格式正确（64 位十六进制）' : `${cleaned.length} / 64 位十六进制`) : '只包含 0–9 和 a–f，共 64 个字符'}
      </div>
      <div className="ob-actions ob-actions--row">
        <Button variant="primary" size="lg" disabled={!valid} onClick={() => onSubmit(key)}>解密并进入</Button>
        <Button variant="ghost" size="lg" onClick={onLive}>改用实时抓取</Button>
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
      <Ops grid items={[
        { t: <>先在微信里<strong>退出登录</strong>，让微信停在登录页；<strong>不要关闭微信程序</strong></> },
        { t: <>回到 Murmur，点下面的「开始抓密钥」—— 我会把 hook 装到当前微信进程</> },
        { t: <>看到「等待登录事件」后，立刻回微信点<strong>登录 / 扫码登录</strong></> },
        { t: '读到密钥后会马上解密全部数据，然后进入 Murmur' },
      ]} />
      <Note tone="warning" label="ORDER" className="ui-mt-3">
        关键：先停在登录页，再点开始，最后去微信登录。一直保持已登录，hook 抓不到登录那一瞬间的密钥。
      </Note>
      {!running && (
        <>
          <InlineError code="WECHAT_NOT_RUNNING" className="ui-mt-3" />
          <div className="ob-muted ui-mt-2"><i className="ui-led is-pulse" /> Murmur 每 2.5 秒会自动重新检测一次。</div>
        </>
      )}
      <div className="ob-actions ob-actions--row">
        <Button variant="primary" size="lg" disabled={!running} onClick={onStart}>开始抓密钥</Button>
        {!running && (
          <Button variant="secondary" size="lg" icon={<IconRefresh size={16} />} loading={rechecking} onClick={onRecheck}>
            再次检测微信
          </Button>
        )}
      </div>
    </>
  );
}
