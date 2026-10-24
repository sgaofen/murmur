// Checks app/src/onboarding/flow.ts — the onboarding decision tree and the
// self-check rows — against hand-written /api/diagnose payloads.
// Run by tests/test_onboarding_flow_frontend.py via `node --experimental-strip-types`
// (Node >= 22.6) or `bun`; can also be run by hand:
//   bun tests/js/onboarding_flow_check.mjs
// Prints one line per failure and exits non-zero if any check fails.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const flow = await import(pathToFileURL(join(root, 'app', 'src', 'onboarding', 'flow.ts')).href);
const { routeAfterCheck, routeStep, stepsFor, buildChecks, blockingCount, liveRecommended, VIEW_STEP } = flow;

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

for (const f of failures) console.log(f);
console.log(`onboardingFlow: ${checks} checks, ${failures.length} failures`);
process.exit(failures.length ? 1 : 0);
