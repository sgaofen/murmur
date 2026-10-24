// Error catalog — maps the stable `code` the backend attaches to error
// payloads (cli/error_codes.py) to a human explanation. Unknown codes fall
// back to the raw `error` text. Keep in sync with cli/error_codes.py;
// tests/test_error_codes.py fails if a backend code is missing here.
//
// Levels (borrowed from WeFlow's errorCatalog):
//   blocking — 无法继续：环境不满足，不处理就走不下去
//   action   — 需要处理：用户做一步操作就能好
//   retry    — 建议重试：多半是暂时性的
//   info     — 结合判断：不一定是错，看具体情况

export type ErrorLevel = 'blocking' | 'action' | 'retry' | 'info';

export interface ErrorEntry {
  level: ErrorLevel;
  title: string;
  reason: string;
  fix: string;
}

export const ERROR_LEVEL_LABEL: Record<ErrorLevel, string> = {
  blocking: '无法继续',
  action: '需要处理',
  retry: '建议重试',
  info: '结合判断',
};

export const ERROR_CATALOG: Record<string, ErrorEntry> = {
  // ---- 微信环境 ----
  WECHAT_NOT_RUNNING: {
    level: 'action',
    title: '没有检测到正在运行的微信',
    reason: '读取密钥需要微信程序开着：Windows 要等一次登录事件，Mac 要从运行中的微信内存里找。',
    fix: '先打开微信（Windows 停在登录页、不要关闭程序；Mac 正常登录），再回到 Murmur 重试。',
  },
  WECHAT_DATA_NOT_FOUND: {
    level: 'action',
    title: '没找到微信数据目录',
    reason: '在常见位置和你保存的路径下都没找到 wxid_*/db_storage。可能这台电脑还没登录过微信，或者数据存在了自定义位置。',
    fix: '先用微信在这台电脑上登录一次；如果改过存储位置，到微信「设置 → 文件管理」打开文件夹，把路径粘贴给 Murmur，或用全盘扫描。',
  },
  WECHAT_DB_NOT_SYNCED: {
    level: 'action',
    title: '微信还没生成加密数据库',
    reason: '找到了账号目录，但里面还没有加密的数据库文件，通常是刚登录、首次同步还没完成。',
    fix: '让微信保持登录几分钟，点开聊天列表和几个对话，等同步完成后再试。',
  },
  WECHAT_APP_NOT_FOUND: {
    level: 'blocking',
    title: '没找到微信程序',
    reason: '没有在默认安装位置找到 WeChat.app / Weixin.exe。',
    fix: '先安装并打开一次微信；装在非默认位置的话，Mac 可以设置环境变量 MURMUR_WECHAT_APP 指向 WeChat.app。',
  },
  WECHAT_HARDENED: {
    level: 'action',
    title: '微信开启了加固签名，读不了内存',
    reason: 'Mac 版微信带 hardened runtime，系统会拒绝其他程序读取它的内存（task_for_pid denied）。',
    fix: '在引导里点「重签名」（会要开机密码，不用关 SIP），然后完全退出并重新打开微信、登录，再回来抓密钥。',
  },
  TCC_BLOCKED: {
    level: 'blocking',
    title: 'macOS 拦截了数据访问',
    reason: '系统隐私保护（TCC）不让 Murmur 读取微信的数据目录。',
    fix: '打开「系统设置 → 隐私与安全性 → 完全磁盘访问权限」，勾选 Murmur，然后完全退出 Murmur 再重新打开。',
  },
  PERMISSION_DENIED: {
    level: 'action',
    title: '没有读取权限',
    reason: '读取或写入某个文件时被系统拒绝。',
    fix: 'Mac：给 Murmur 完全磁盘访问权限。Windows：微信和 Murmur 都用普通权限打开（不要一个管理员一个普通），并确认杀毒软件没有拦截。',
  },
  AUTH_CANCELLED: {
    level: 'retry',
    title: '系统授权窗口被取消了',
    reason: '这一步需要管理员权限，系统弹出的密码窗口被关闭或取消了。',
    fix: '重新点一次，在系统弹窗里输入这台电脑的开机密码（不是 Apple ID 密码）。',
  },
  RESIGN_FAILED: {
    level: 'action',
    title: '给微信重签名失败',
    reason: 'codesign 没能清掉微信的加固签名，常见于微信还在运行，或 Murmur 不在「应用程序」文件夹里。',
    fix: '完全退出微信，把 Murmur 拖进「应用程序」后从那里打开，再点重签名；还不行就复制诊断信息发 issue。',
  },
  WIN_HOOK_FAILED: {
    level: 'action',
    title: '密钥 hook 没装上',
    reason: '注入微信进程的 wx_key.dll 没有加载成功，多半是被杀毒软件 / Defender 拦截或隔离了。',
    fix: '把 Murmur 安装目录加入杀毒软件白名单，确认 wx_key.dll 没被隔离；重启电脑后微信和 Murmur 都用普通权限打开再试。',
  },
  PLATFORM_UNSUPPORTED: {
    level: 'blocking',
    title: '当前系统还不支持这个功能',
    reason: '这个操作只在特定系统上可用（例如 QQ 导入目前只支持 Windows，重签名只在 Mac 上需要）。',
    fix: '换到支持的系统上操作，或先使用其他已支持的功能。',
  },

  // ---- 密钥 ----
  KEY_NOT_FOUND: {
    level: 'action',
    title: '还没拿到解密密钥',
    reason: '没有保存过密钥，或这次没从微信里读到。Windows 要在点开始之后发生一次新的登录；Mac 要微信已经打开过对应的数据库。',
    fix: 'Windows：让微信停在登录页 → 点开始抓密钥 → 90 秒内回微信登录。Mac：先在微信里点开几个聊天、群聊和朋友圈，再重新抓。',
  },
  KEY_INVALID: {
    level: 'action',
    title: '密钥对不上这个账号',
    reason: '保存的密钥解不开数据库。多账号时最常见：抓密钥时登录的不是现在要解密的那个号。',
    fix: '确认微信当前登录的就是要导出的账号，回到「密钥」重新抓一次，再点更新数据。',
  },
  KEY_FORMAT_INVALID: {
    level: 'action',
    title: '密钥格式不对',
    reason: '密钥必须是 64 位十六进制字符（0-9、a-f）。',
    fix: '检查是否少复制或多复制了字符、带了空格或引号；不确定的话直接用自动抓取。',
  },

  // ---- Mac 实时抓取（Frida） ----
  FRIDA_MISSING: {
    level: 'action',
    title: '还没装 Frida',
    reason: '实时抓取要用 Frida 挂到微信的加密调用上，但当前后端里找不到它。打包版 App 不能在线安装。',
    fix: '开发版点「安装 Frida」；打包版按提示用命令行方式运行实时抓取。',
  },
  LIVE_KEY_FAILED: {
    level: 'retry',
    title: '实时抓取中途退出了',
    reason: '抓取子进程意外退出（日志里的 exit-N 是它的退出码）。',
    fix: '再试一次；仍然失败就展开日志，复制诊断信息发 issue。',
  },

  // ---- 解密与数据 ----
  NO_DECRYPTED_DATA: {
    level: 'action',
    title: '还没有解密好的数据',
    reason: '后端已经启动，但还没找到可用的解密数据，所以这个功能暂时用不了。',
    fix: '按初始化引导选择微信数据目录、抓密钥并解密。',
  },
  DECRYPT_INCOMPLETE: {
    level: 'retry',
    title: '有数据库没解出来',
    reason: '核心数据库没有解密成功，或解密后替换文件时失败了。Mac 上常见原因是有些数据库的密钥还没进入微信内存。',
    fix: '在微信里点开聊天列表、几个对话和朋友圈后重新抓密钥，再点更新数据；替换失败的话检查磁盘空间和权限。',
  },
  DECRYPT_FAILED: {
    level: 'retry',
    title: '解密没有完成',
    reason: '解密过程中途出错，具体原因见下方原始报错。',
    fix: '先再试一次；仍然失败就复制诊断信息发 issue。',
  },
  STORE_INIT_FAILED: {
    level: 'action',
    title: '解密完成了，但数据加载失败',
    reason: '解密目录里的数据库打不开，常见原因：session.db 损坏、表结构不匹配，或残留了上次失败的文件。',
    fix: '完全退出 Murmur，删除 ~/Documents/Murmur/decrypted/ 整个目录，先在微信里点开聊天列表和几个对话，再重新走引导。',
  },
  DB_MALFORMED: {
    level: 'action',
    title: '解密后的数据库损坏',
    reason: 'SQLite 报告数据库文件损坏（malformed），可能是解密中断，或微信升级后表结构变了。',
    fix: '用「重新解密」强制刷新一次（会清空旧的解密目录）；QQ 用户请重新登录 QQ 后重新抓 key 并解密。',
  },
  DB_BUSY: {
    level: 'retry',
    title: '数据库暂时被占用',
    reason: '微信或其他程序正在写这个数据库。',
    fix: '稍等几秒再点一次更新数据。',
  },
  DISK_IO: {
    level: 'blocking',
    title: '磁盘读写出错',
    reason: '写解密结果时磁盘报错，常见原因是空间不够。',
    fix: '清理出足够空间（至少是微信数据大小的两倍）后重试，或换一个磁盘。',
  },

  // ---- QQ ----
  QQ_DATA_NOT_FOUND: {
    level: 'action',
    title: '没找到 QQ 数据',
    reason: '在 Tencent Files 下没有找到对应 QQ 号的 nt_qq/nt_db/nt_msg.db。',
    fix: '确认这台电脑登录过这个 QQ，并把「Tencent Files」文件夹路径粘贴给 Murmur。',
  },
  QQ_KEY_NOT_FOUND: {
    level: 'action',
    title: '还没有这个 QQ 的密钥',
    reason: '没有保存过这个 QQ 号的数据库密钥。',
    fix: '先在 QQ 引导里抓取密钥，再点解密。',
  },
  QQ_KEY_INVALID: {
    level: 'action',
    title: 'QQ 密钥不对',
    reason: '用这个密钥解不开 QQ 数据库，可能抓到的是别的号，或 QQ 重新登录后密钥变了。',
    fix: '重新登录要导出的 QQ，然后重新抓 key 再解密。',
  },

  // ---- 应用锁 ----
  APP_LOCKED: {
    level: 'action',
    title: 'Murmur 已锁定',
    reason: '开启了应用锁，解锁前本地服务不返回任何聊天数据。',
    fix: '输入应用锁密码解锁。忘记密码见「设置 → 应用锁」里的重置说明。',
  },
  APP_LOCK_WRONG_PASSWORD: {
    level: 'action',
    title: '密码不对',
    reason: '输入的应用锁密码和设置的不一致。连续输错几次后要等一会儿才能再试。',
    fix: '检查大小写和输入法后重新输入。',
  },
  APP_LOCK_RATE_LIMITED: {
    level: 'retry',
    title: '尝试次数过多',
    reason: '连续输错密码，为了防止被猜中，需要等一会儿才能再试；每多错一次等待时间翻倍，最长 5 分钟。',
    fix: '等倒计时结束后再输入。',
  },
  APP_LOCK_INVALID: {
    level: 'action',
    title: '应用锁设置不对',
    reason: '密码太短，或者闲置时间不在可选范围里。',
    fix: '密码至少 4 位；闲置时间选 5 / 15 / 30 分钟或从不。',
  },

  // ---- 其他 ----
  TIMEOUT: {
    level: 'retry',
    title: '操作超时了',
    reason: '等待的时间超过了上限。抓密钥时通常是倒计时内没有完成登录。',
    fix: '再试一次；如果是抓密钥，点开始后尽快回到微信完成登录。',
  },
  AGENT_NOT_INSTALLED: {
    level: 'blocking',
    title: '没找到 AI 命令行工具',
    reason: '这个功能要调用本机的 Claude / Codex 命令行，但没检测到。',
    fix: '先安装对应的命令行工具并登录，然后重开 Murmur。',
  },
  ORIGIN_NOT_ALLOWED: {
    level: 'info',
    title: '请求来源被拒绝',
    reason: '本地后端只接受 Murmur 自己的页面发来的请求。',
    fix: '请从 Murmur 应用里操作；开发模式下前端要跑在 5173 端口。',
  },
  INTERNAL_ERROR: {
    level: 'info',
    title: '后端出错了',
    reason: '后端遇到了没有预料到的错误，具体原因见下方原始报错。',
    fix: '再试一次；能复现的话复制诊断信息发 issue。',
  },

  // ---- 仅前端 ----
  BACKEND_UNREACHABLE: {
    level: 'retry',
    title: '连不上本地后端',
    reason: 'Murmur 的本地后端（etcli）没有响应，可能还在启动，或者已经退出了。',
    fix: '等几秒再试；还不行就完全退出 Murmur 重开，并查看 ~/Documents/Murmur/logs/serve.log。',
  },
};

/** Catalog entry for a code, or null when unknown / missing (caller then
 * shows the raw error text). */
export function lookupError(code: string | null | undefined): ErrorEntry | null {
  if (!code) return null;
  return ERROR_CATALOG[code] ?? null;
}

/** One-line summary: the catalog title when known, else the raw text. */
export function errorSummary(code: string | null | undefined, raw: string): string {
  return lookupError(code)?.title ?? raw;
}
