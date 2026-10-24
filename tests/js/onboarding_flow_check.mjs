// Checks app/src/onboarding/flow.ts — the onboarding decision tree and the
// self-check rows — against hand-written /api/diagnose payloads, plus the
// busy / resume rules (capture.ts) and the double-click guard (guard.ts).
// Run by tests/test_onboarding_flow_frontend.py via `node --experimental-strip-types`
// (Node >= 22.6) or `bun`; can also be run by hand:
//   bun tests/js/onboarding_flow_check.mjs
// Prints one line per failure and exits non-zero if any check fails.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const load = name => import(pathToFileURL(join(root, 'app', 'src', 'onboarding', name)).href);
const flow = await load('flow.ts');
const { routeAfterCheck, routeStep, stepsFor, buildChecks, blockingCount, liveRecommended, VIEW_STEP } = flow;
const { dialogBusy, privateCopyShortcut, fridaNeedsResign, canForceDecrypt, savedKeyPath, keyExtractFailureCode } = flow;
const { liveBusy, privateCopyBusy, resumeMethod } = await load('capture.ts');
const { createActionGuard } = await load('guard.ts');

const failures = [];
let checks = 0;
function eq(name, got, want) {
  checks++;
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) failures.push(`${name}: got ${g}, want ${w}`);
}

const PROFILE = { wxid: 'wxid_x', wxid_short: 'wxid_x', encrypted_root: '/x', decrypted_root: '/y', has_decrypted_data: false };

function diag(over = {}, caps = {}) {
  return {
    platform: 'macos', python: '3.9',
    capabilities: {
      can_decrypt_db: true, can_extract_key: false, can_extract_image_key: false,
      has_wechat_installed: true, has_wechat_data: true,
      sip_enabled: true, weixin_running: null, wechat_hardened: false, tcc_blocked: false,
      ...caps,
    },
    profiles: [PROFILE], saved_key: false, agents_found: 0, notes: [], wechat_exe: null,
    murmur_home: '/m', wechat_search_roots: [], wechat_version: '4.1.22',
    live_key: { recommended: true, frida: { installed: false, version: null, installable: true, frozen: false } },
    private_copy: { available: true, copy_exists: false },
    ...over,
  };
}

// ——— routeAfterCheck: same order as the pre-UI-4 decision tree ———
const view = v => ({ kind: 'view', view: v });
eq('decrypted data → done', routeAfterCheck(diag({ profiles: [{ ...PROFILE, has_decrypted_data: true }] })), view('done'));
eq('win, data, no key → key', routeAfterCheck(diag({ platform: 'windows' })), view('key'));
eq('win, data, key → decrypt', routeAfterCheck(diag({ platform: 'windows', saved_key: true })), { kind: 'decrypt' });
eq('win, no data → data', routeAfterCheck(diag({ platform: 'windows', profiles: [] })), view('data'));
eq('mac, TCC blocked → fda (before anything else)',
  routeAfterCheck(diag({ profiles: [], saved_key: true }, { tcc_blocked: true })), view('fda'));
eq('mac, no data → data', routeAfterCheck(diag({ profiles: [] })), view('data'));
eq('mac, saved key → decrypt', routeAfterCheck(diag({ saved_key: true }, { can_extract_key: true })), { kind: 'decrypt' });
eq('mac, can extract → key', routeAfterCheck(diag({}, { can_extract_key: true })), view('key'));
eq('mac, hardened → auth', routeAfterCheck(diag({}, { wechat_hardened: true })), view('auth'));
eq('mac, neither → paste', routeAfterCheck(diag({}, { wechat_hardened: null })), view('paste'));
eq('linux → error WECHAT_DATA_NOT_FOUND', routeAfterCheck(diag({ platform: 'linux', profiles: [] })),
  { kind: 'error', step: 'data', code: 'WECHAT_DATA_NOT_FOUND' });

eq('routeStep(view key)', routeStep(view('key')), 'key');
eq('routeStep(decrypt)', routeStep({ kind: 'decrypt' }), 'decrypt');
eq('VIEW_STEP fda belongs to 数据目录', VIEW_STEP.fda, 'data');
eq('VIEW_STEP wait-login belongs to 取得密钥', VIEW_STEP['wait-login'], 'key');

// ——— steps ———
eq('mac steps', stepsFor('macos'), ['check', 'data', 'auth', 'key', 'decrypt', 'done']);
eq('windows steps', stepsFor('windows'), ['check', 'data', 'key', 'decrypt', 'done']);
eq('every view maps to a step of its platform',
  Object.values(VIEW_STEP).every(s => stepsFor('macos').includes(s)), true);

// ——— self-check rows ———
const ids = d => buildChecks(d).map(r => r.id);
const row = (d, id) => buildChecks(d).find(r => r.id === id);
eq('mac rows', ids(diag()), ['wechat', 'data', 'fda', 'sign', 'frida', 'keycap', 'key']);
eq('windows rows', ids(diag({ platform: 'windows', live_key: null, private_copy: null })), ['wechat', 'data', 'key']);
eq('mac version shown', row(diag(), 'wechat').value, '4.1.22');
eq('live recommended ≥ 4.1.9', liveRecommended(diag()), true);
eq('TCC blocked → fda bad + open-fda', [row(diag({}, { tcc_blocked: true }), 'fda').status,
  row(diag({}, { tcc_blocked: true }), 'fda').action?.kind], ['bad', 'open-fda']);
eq('TCC blocked → data bad', row(diag({ profiles: [] }, { tcc_blocked: true }), 'data').status, 'bad');
eq('no data → goto-data', row(diag({ profiles: [] }), 'data').action?.kind, 'goto-data');
eq('hardened → sign warn + goto-auth', [row(diag({}, { wechat_hardened: true }), 'sign').status,
  row(diag({}, { wechat_hardened: true }), 'sign').action?.kind], ['warn', 'goto-auth']);
eq('frida missing (installable, 4.1.9+) → warn + install', [row(diag(), 'frida').status, row(diag(), 'frida').action?.kind],
  ['warn', 'install-frida']);
eq('frida missing in packaged app → off, no action',
  [row(diag({ live_key: { recommended: true, frida: { installed: false, version: null, installable: false, frozen: true } } }), 'frida').status,
    row(diag({ live_key: { recommended: true, frida: { installed: false, version: null, installable: false, frozen: true } } }), 'frida').action],
  ['off', undefined]);
eq('frida installed → ok', row(diag({ live_key: { recommended: true, frida: { installed: true, version: '17.2.4', installable: true, frozen: false } } }), 'frida').value,
  '已安装 17.2.4');
eq('capture dylib missing → off', row(diag({ private_copy: { available: false, copy_exists: false } }), 'keycap').status, 'off');
eq('windows, WeChat not running → warn + recheck',
  [row(diag({ platform: 'windows' }, { weixin_running: false }), 'wechat').status,
    row(diag({ platform: 'windows' }, { weixin_running: false }), 'wechat').action?.kind], ['warn', 'recheck']);
eq('saved key → ok', row(diag({ saved_key: true }), 'key').status, 'ok');
eq('blocking count', blockingCount(buildChecks(diag({ profiles: [] }, { tcc_blocked: true }))), 2);
eq('healthy mac has nothing blocking', blockingCount(buildChecks(diag())), 0);

// ——— #47 review: busy while a capture round runs ———
eq('spinner screens are busy', ['resigning', 'extracting', 'decrypting'].map(v => dialogBusy(v, false, false)), [true, true, true]);
eq('checking is busy', dialogBusy('check', true, false), true);
eq('live screen busy only while a capture runs', [dialogBusy('live', false, true), dialogBusy('live', false, false)], [true, false]);
eq('capture flag ignored off the live screen', dialogBusy('auth', false, true), false);
eq('welcome / error never busy', [dialogBusy('welcome', false, true), dialogBusy('error', false, true)], [false, false]);

const live = (job, install = false) => ({ job: { running: job }, install: { running: install } });
const pc = job => ({ job: { running: job } });
eq('liveBusy: Frida round', liveBusy(live(true)), true);
eq('liveBusy: Frida install', liveBusy(live(false, true)), true);
eq('liveBusy: idle / unknown', [liveBusy(live(false)), liveBusy(null)], [false, false]);
eq('privateCopyBusy', [privateCopyBusy(pc(true)), privateCopyBusy(pc(false)), privateCopyBusy(undefined)], [true, false, false]);
eq('resume: nothing running → chooser', resumeMethod(live(false), pc(false)), null);
eq('resume: Frida round → frida', resumeMethod(live(true), pc(false)), 'frida');
eq('resume: Frida install → frida', resumeMethod(live(false, true), null), 'frida');
eq('resume: private copy → private-copy', resumeMethod(live(false), pc(true)), 'private-copy');
eq('resume: status unknown → chooser', resumeMethod(null, null), null);

// ——— #47 review: smaller decisions ———
eq('免 Frida shortcut needs the bundled dylib',
  [privateCopyShortcut(diag()), privateCopyShortcut(diag({ private_copy: { available: false, copy_exists: false } })),
    privateCopyShortcut(diag({ private_copy: null }))], [true, false, false]);
eq('Frida card: needs re-sign only while hardened on Mac',
  [fridaNeedsResign(diag({}, { wechat_hardened: true })), fridaNeedsResign(diag()),
    fridaNeedsResign(diag({ platform: 'windows' }, { wechat_hardened: true }))], [true, false, false]);
eq('清空后重新解密 only with a saved key', [canForceDecrypt(diag({ saved_key: true })), canForceDecrypt(diag()), canForceDecrypt(null)],
  [true, false, false]);
eq('key path: Mac pasted key lives in config.json', savedKeyPath('macos', 'paste'), '~/.murmur/config.json');
eq('key path: Mac captured keys', savedKeyPath('macos', 'capture'), '~/.murmur/decrypted_keys.json');
eq('key path: Mac, saved before this run → unknown', savedKeyPath('macos', null), null);
eq('key path: Windows', [savedKeyPath('windows', 'capture'), savedKeyPath('windows', null)],
  ['~/.murmur/config.json', '~/.murmur/config.json']);
eq('extract failure: explicit empty answer → KEY_NOT_FOUND', keyExtractFailureCode({ code: null, log: '' }, false), 'KEY_NOT_FOUND');
eq('extract failure: backend code kept', keyExtractFailureCode({ code: 'WECHAT_HARDENED' }, false), 'WECHAT_HARDENED');
eq('extract failure: Windows hook install → WIN_HOOK_FAILED',
  keyExtractFailureCode({ code: 'KEY_NOT_FOUND', log: '[X] Hook install failed: x' }, true), 'WIN_HOOK_FAILED');
eq('extract failure: Mac log never remapped to the Windows hook code',
  keyExtractFailureCode({ code: null, log: 'hook install failed' }, false), 'KEY_NOT_FOUND');

// ——— #47 review: double clicks send one request ———
{
  const g = createActionGuard();
  let calls = 0;
  let release;
  const slow = () => { calls++; return new Promise(r => { release = r; }); };
  const first = g.run(slow);
  g.run(slow);              // double click while the first is in flight
  g.run(() => { calls++; }); // any other action too
  eq('guard: second call dropped while pending', [calls, g.pending], [1, true]);
  release();
  await first;
  eq('guard: free again once settled', g.pending, false);
  await g.run(() => { calls++; });
  eq('guard: next action runs', calls, 2);
  const failing = g.run(() => Promise.reject(new Error('boom')));
  let rejected = false;
  await failing.catch(() => { rejected = true; });
  eq('guard: a failed action frees it and still rejects', [rejected, g.pending], [true, false]);
  let threw = false;
  try { await g.run(() => { throw new Error('sync'); }); } catch { threw = true; }
  eq('guard: a throwing action frees it', [threw, g.pending], [true, false]);
}

for (const f of failures) console.log(f);
console.log(`onboardingFlow: ${checks} checks, ${failures.length} failures`);
process.exit(failures.length ? 1 : 0);
