// WeChat onboarding flow model — pure functions, no React, no runtime imports
// (tests/js/onboarding_flow_check.mjs runs this file directly under Node/Bun).
//
//   环境自检 → 数据目录 → 授权/重签 (Mac only) → 取得密钥 → 解密 → 完成
//
// `routeAfterCheck` is the old OnboardingDialog decision tree, unchanged: it
// picks the step (and the screen inside it) a fresh /api/diagnose lands on.
// `buildChecks` turns the same diagnose payload into the self-check rows.
import type { Diagnose } from '../data/api';

export type StepKey = 'check' | 'data' | 'auth' | 'key' | 'decrypt' | 'done';
export type Platform = Diagnose['platform'];

export const STEP_LABEL: Record<StepKey, string> = {
  check: '环境自检',
  data: '数据目录',
  auth: '授权/重签',
  key: '取得密钥',
  decrypt: '解密',
  done: '完成',
};

/** Steps shown in the rail. Windows / Linux need no permission or re-sign step. */
export function stepsFor(platform: Platform | null | undefined): StepKey[] {
  return platform === 'macos'
    ? ['check', 'data', 'auth', 'key', 'decrypt', 'done']
    : ['check', 'data', 'key', 'decrypt', 'done'];
}

/** Screens. Each one belongs to exactly one step (see VIEW_STEP). */
export type View =
  | 'check'        // 环境自检 list
  | 'fda'          // Mac: TCC hides the WeChat container → grant 完全磁盘访问
  | 'data'         // found accounts / pick a folder / Windows disk scan
  | 'auth'         // Mac: re-sign WeChat (hardened runtime)
  | 'resigning'
  | 'wait-login'   // Mac: re-signed + relaunched, log in then capture
  | 'key'          // Mac: memory scan / live capture choice · Windows: login hook
  | 'live'         // Mac: LiveKeyCapture (Frida / 免 Frida)
  | 'paste'        // Mac: paste a 64-hex key
  | 'extracting'
  | 'decrypt'      // redo: run decrypt again on demand
  | 'decrypting'
  | 'done';

export const VIEW_STEP: Record<View, StepKey> = {
  check: 'check',
  fda: 'data',
  data: 'data',
  auth: 'auth',
  resigning: 'auth',
  'wait-login': 'key',
  key: 'key',
  live: 'key',
  paste: 'key',
  extracting: 'key',
  decrypt: 'decrypt',
  decrypting: 'decrypt',
  done: 'done',
};

/** Screens that run something in the background (spinner, no buttons). */
export const BUSY_VIEWS: ReadonlySet<View> = new Set<View>(['resigning', 'extracting', 'decrypting']);

/** Is the onboarding busy (step rail and Esc / close disabled)? Besides the
 * spinner screens, the live-capture screen is busy while a Frida round, the
 * Frida install or a private-copy round runs (LiveKeyCapture reports it):
 * re-signing or a memory scan then would kill WeChat under that round. */
export function dialogBusy(screen: View | 'welcome' | 'error', checking: boolean, captureBusy: boolean): boolean {
  if (checking) return true;
  if (screen === 'welcome' || screen === 'error') return false;
  return BUSY_VIEWS.has(screen) || (screen === 'live' && captureBusy);
}

export type Route =
  | { kind: 'view'; view: View }
  /** Key is already saved — decrypt right away (old behaviour). */
  | { kind: 'decrypt' }
  | { kind: 'error'; step: StepKey; code: string };

export function hasDecryptedData(d: Diagnose): boolean {
  return d.profiles.some(p => p.has_decrypted_data);
}

/** Where a fresh diagnose lands — same order as the pre-UI-4 decision tree. */
export function routeAfterCheck(d: Diagnose): Route {
  const hasData = d.profiles.length > 0;
  if (hasDecryptedData(d)) return { kind: 'view', view: 'done' };
  if (d.platform === 'windows' && hasData) {
    return d.saved_key ? { kind: 'decrypt' } : { kind: 'view', view: 'key' };
  }
  if (d.platform === 'macos') {
    // TCC first: without 完全磁盘访问 nothing else under ~/Library/Containers is readable.
    if (d.capabilities.tcc_blocked) return { kind: 'view', view: 'fda' };
    if (!hasData) return { kind: 'view', view: 'data' };
    if (d.saved_key) return { kind: 'decrypt' };
    if (d.capabilities.can_extract_key) return { kind: 'view', view: 'key' };
    if (d.capabilities.wechat_hardened === true) return { kind: 'view', view: 'auth' };
    return { kind: 'view', view: 'paste' };
  }
  if (d.platform === 'windows') return { kind: 'view', view: 'data' };
  return { kind: 'error', step: 'data', code: 'WECHAT_DATA_NOT_FOUND' };
}

export function routeStep(r: Route): StepKey {
  if (r.kind === 'view') return VIEW_STEP[r.view];
  if (r.kind === 'decrypt') return 'decrypt';
  return r.step;
}

/** WeChat for Mac 4.1.9+ no longer keeps DB keys in memory → live capture first. */
export function liveRecommended(d: Diagnose | null | undefined): boolean {
  return !!d?.live_key?.recommended;
}

// ———————————————————————— self-check rows ————————————————————————

/** ok = fine · warn = works but needs attention · bad = blocks a step ·
 * off = optional / not needed / unknown · info = neutral fact. */
export type CheckStatus = 'ok' | 'warn' | 'bad' | 'off' | 'info';

export type CheckAction =
  | 'open-fda'       // open System Settings → 完全磁盘访问
  | 'goto-data'      // 数据目录 step
  | 'goto-auth'      // 授权/重签 step
  | 'install-frida'  // pip install frida (source checkouts only)
  | 'recheck';       // run /api/diagnose again

export interface CheckRow {
  id: 'wechat' | 'data' | 'fda' | 'sign' | 'frida' | 'keycap' | 'key';
  label: string;
  status: CheckStatus;
  value: string;
  hint?: string;
  action?: { kind: CheckAction; label: string };
}

export function buildChecks(d: Diagnose): CheckRow[] {
  const caps = d.capabilities;
  const mac = d.platform === 'macos';
  const rows: CheckRow[] = [];
  const nProfiles = d.profiles.length;

  // 微信版本 / 微信程序
  if (mac) {
    if (!caps.has_wechat_installed) {
      rows.push({ id: 'wechat', label: '微信版本', status: 'bad', value: '没找到 WeChat.app',
        hint: '先安装并登录一次 Mac 版微信。', action: { kind: 'recheck', label: '重新检测' } });
    } else if (d.wechat_version) {
      rows.push({ id: 'wechat', label: '微信版本', status: 'ok', value: d.wechat_version,
        hint: liveRecommended(d)
          ? '4.1.9 及以上：密钥不再常驻内存，取得密钥时推荐用「实时抓取」。'
          : '4.1.9 以前：可以直接用内存扫描取得密钥。' });
    } else {
      rows.push({ id: 'wechat', label: '微信版本', status: 'info', value: '已安装，版本未知' });
    }
  } else if (d.platform === 'windows') {
    if (!caps.has_wechat_installed) {
      rows.push({ id: 'wechat', label: '微信程序', status: 'bad', value: '没找到微信',
        hint: '先安装并登录一次 Windows 版微信。', action: { kind: 'recheck', label: '重新检测' } });
    } else if (caps.weixin_running === false) {
      rows.push({ id: 'wechat', label: '微信程序', status: 'warn', value: '已安装 · 没在运行',
        hint: '取得密钥时需要微信开着，并停在登录页。', action: { kind: 'recheck', label: '重新检测' } });
    } else {
      rows.push({ id: 'wechat', label: '微信程序', status: 'ok',
        value: caps.weixin_running ? '已安装 · 正在运行' : '已安装' });
    }
  }

  // 数据目录
  if (nProfiles > 0) {
    rows.push({ id: 'data', label: '数据目录', status: 'ok',
      value: `找到 ${nProfiles} 个账号${hasDecryptedData(d) ? ' · 已解密过' : ''}`,
      action: { kind: 'goto-data', label: '查看' } });
  } else if (mac && caps.tcc_blocked) {
    rows.push({ id: 'data', label: '数据目录', status: 'bad', value: '被系统权限挡住',
      hint: '先给 Murmur 完全磁盘访问，才能看到微信的数据目录。' });
  } else {
    rows.push({ id: 'data', label: '数据目录', status: 'bad', value: '还没找到',
      hint: mac ? '可能还没登录过微信，或者数据放在了自定义位置。' : '可以全盘扫描，或者手动粘贴路径。',
      action: { kind: 'goto-data', label: mac ? '指定目录' : '去查找' } });
  }

  if (mac) {
    // 完全磁盘访问
    if (caps.tcc_blocked === true) {
      rows.push({ id: 'fda', label: '完全磁盘访问', status: 'bad', value: '未授权',
        hint: '授权后要完全退出 Murmur 再打开才生效。', action: { kind: 'open-fda', label: '打开系统设置' } });
    } else if (caps.tcc_blocked === false) {
      rows.push({ id: 'fda', label: '完全磁盘访问', status: 'ok', value: '已授权' });
    } else {
      rows.push({ id: 'fda', label: '完全磁盘访问', status: 'off', value: '未检测' });
    }

    // 微信签名（重签）
    if (caps.wechat_hardened === true) {
      rows.push({ id: 'sign', label: '微信签名', status: 'warn', value: '加固签名（微信默认）',
        hint: '内存扫描和 Frida 方式要先重签名；免 Frida 方式不需要。',
        action: { kind: 'goto-auth', label: '去重签名' } });
    } else if (caps.wechat_hardened === false) {
      rows.push({ id: 'sign', label: '微信签名', status: 'ok', value: '已重签（ad-hoc）' });
    }

    // Frida
    const frida = d.live_key?.frida;
    if (!frida) {
      rows.push({ id: 'frida', label: 'Frida', status: 'off', value: '未检测' });
    } else if (frida.installed) {
      rows.push({ id: 'frida', label: 'Frida', status: 'ok',
        value: frida.version ? `已安装 ${frida.version}` : '已安装' });
    } else if (frida.installable) {
      rows.push({ id: 'frida', label: 'Frida', status: liveRecommended(d) ? 'warn' : 'off', value: '未安装',
        hint: '实时抓取的 Frida 方式需要它（约 45\u00a0MB）；免 Frida 方式不需要。',
        action: { kind: 'install-frida', label: '一键安装' } });
    } else {
      rows.push({ id: 'frida', label: 'Frida', status: 'off', value: '这个版本没带',
        hint: '可以改用免 Frida 方式，或按提示用终端运行。' });
    }

    // 捕获组件 (private-copy dylib)
    const pc = d.private_copy;
    if (!pc) {
      rows.push({ id: 'keycap', label: '捕获组件', status: 'off', value: '未检测' });
    } else if (pc.available) {
      rows.push({ id: 'keycap', label: '捕获组件', status: 'ok', value: '已就绪',
        hint: '免 Frida 方式（私有副本）可以用。' });
    } else {
      rows.push({ id: 'keycap', label: '捕获组件', status: 'off', value: '没有打包',
        hint: '免 Frida 方式用不了，可以改用 Frida 方式。' });
    }
  }

  // 解密密钥
  rows.push(d.saved_key
    ? { id: 'key', label: '解密密钥', status: 'ok', value: '已保存' }
    : { id: 'key', label: '解密密钥', status: 'off', value: '还没有', hint: '后面的「取得密钥」一步会带你拿到。' });

  return rows;
}

/** Rows that block the next step (shown as 「n 项需要处理」). */
export function blockingCount(rows: CheckRow[]): number {
  return rows.filter(r => r.status === 'bad').length;
}

// ———————————————————————— small decisions the screens make ————————————————————————

/** 授权/重签 → 「先不重签：用免 Frida 方式」: only when the capture dylib is bundled. */
export function privateCopyShortcut(d: Diagnose | null | undefined): boolean {
  return d?.private_copy?.available === true;
}

/** Frida (and the memory scan) can't attach to a WeChat that still has hardened runtime. */
export function fridaNeedsResign(d: Diagnose | null | undefined): boolean {
  return d?.platform === 'macos' && d.capabilities.wechat_hardened === true;
}

/** 「清空后重新解密」 deletes the decrypted dir; only offer it when a key is saved
 * (otherwise there is nothing to decrypt it again with). */
export function canForceDecrypt(d: Diagnose | null | undefined): boolean {
  return !!d?.saved_key;
}

/** How the key that was just used got saved: pasted by hand (config.json) or
 * captured by Murmur (Mac: decrypted_keys.json · Windows: config.json). */
export type KeySource = 'paste' | 'capture' | null;

/** Where the key lives, for the 完成 screen. null = not sure (it was already
 * saved before this run). */
export function savedKeyPath(platform: Platform | null | undefined, source: KeySource): string | null {
  if (platform !== 'macos') return '~/.murmur/config.json';
  if (source === 'paste') return '~/.murmur/config.json';
  if (source === 'capture') return '~/.murmur/decrypted_keys.json';
  return null;
}

const HOOK_INSTALL_FAILED = /hook (setup|install) failed|wx_key\.dll|注入到微信进程/i;

/** Error code for an /api/extract-key answer that came back `ok: false`.
 * Only an explicit failure falls back to KEY_NOT_FOUND — network / backend
 * errors keep their own code (see describeError). */
export function keyExtractFailureCode(r: { code?: string | null; log?: string | null }, windows: boolean): string {
  let code = r.code || 'KEY_NOT_FOUND';
  if (windows && code !== 'WIN_HOOK_FAILED' && HOOK_INSTALL_FAILED.test(r.log || '')) code = 'WIN_HOOK_FAILED';
  return code;
}
