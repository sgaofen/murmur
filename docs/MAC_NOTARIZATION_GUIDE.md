# Mac 签名与公证发布流程

目标：让用户从 GitHub Releases 下载 `Murmur_macOS_AppleSilicon.dmg` 后，可以像普通 Mac App 一样安装和打开，不再出现：

- `"Murmur" is damaged and can't be opened`
- `"Murmur" Not Opened. Apple could not verify...`

这件事不能靠 ad-hoc 签名解决。ad-hoc 只能修掉签名结构损坏，不能让 Gatekeeper 认可发布者身份。正式发布必须走：

```text
Developer ID Application 证书
→ hardened runtime 签名
→ Apple 公证
→ stapler 装订公证票据
→ 上传新的 DMG
```

官方依据：

- Apple 说明：Mac App 直接分发时应该使用 Developer ID 签名；未签 Developer ID 的 App 会被 Gatekeeper 拦截。
- Apple 说明：上传公证前需要 hardened runtime；公证完成后可以用 `stapler` 校验/装订票据。
- Tauri 说明：免费账号不能完成公证；ad-hoc 签名仍会要求用户在「隐私与安全性」里手动放行。

参考链接：

- Apple: https://help.apple.com/xcode/mac/current/en.lproj/dev033e997ca.html
- Apple: https://help.apple.com/xcode/mac/current/en.lproj/dev88332a81e.html
- Tauri: https://v2.tauri.app/distribute/sign/macos/

---

## 0. 你需要准备什么

需要：

1. 一台 Mac。
2. Xcode 或 Xcode Command Line Tools。
3. Apple 付费开发者账号。
4. `Developer ID Application` 证书。
5. Apple 公证凭据。
6. 本仓库最新 `main`。

先确认工具：

```bash
xcode-select -p
xcrun notarytool --help
xcrun stapler --help
```

如果没有 Command Line Tools：

```bash
xcode-select --install
```

---

## 1. 创建 Developer ID Application 证书

注意：只有账号持有人或具备相应权限的成员可以创建 Developer ID 证书。如果你的账号权限不够，需要让账号持有人帮你创建，或先调整权限。

在 Mac 上生成 CSR：

1. 打开「钥匙串访问」。
2. 菜单栏：`钥匙串访问` → `证书助理` → `从证书颁发机构请求证书...`
3. 用户电子邮件填你的 Apple ID 邮箱。
4. 常用名称填 `Stephen Yu` 或你的开发者名称。
5. 选择「存储到磁盘」。
6. 保存 `CertificateSigningRequest.certSigningRequest`。

到 Apple 开发者网站创建证书：

1. 打开 https://developer.apple.com/account/resources/certificates/list
2. 点 `+`。
3. 选择 `Developer ID Application`。
4. 上传刚才的 CSR。
5. 下载生成的 `.cer`。
6. 双击 `.cer` 安装到登录钥匙串。

确认本机能看到证书：

```bash
security find-identity -v -p codesigning
```

你需要看到类似：

```text
1) ABCDEF1234567890 "Developer ID Application: Your Name (TEAMID)"
```

把引号里的整段记下来，后面叫它：

```bash
Developer ID Application: Your Name (TEAMID)
```

如果还是 `0 valid identities found`，说明证书没装好、没有私钥，或证书类型不对。

---

## 2. 准备公证凭据

推荐先用 Apple ID + app-specific password，最直观。

拿 Team ID：

1. 打开 https://developer.apple.com/account
2. 进入 Membership / 会员信息。
3. 找 `Team ID`。

创建 app-specific password：

1. 打开 https://appleid.apple.com
2. 登录。
3. `Sign-In and Security` → `App-Specific Passwords`
4. 创建一个，例如名字叫 `Murmur Notary`。
5. 保存生成的密码，只显示一次。

把凭据存进本机钥匙串：

```bash
xcrun notarytool store-credentials murmur-notary \
  --apple-id "你的 Apple ID 邮箱" \
  --team-id "你的 TEAMID" \
  --password "刚生成的 app-specific password"
```

成功后，后面脚本只需要引用 `murmur-notary`，不用再输入密码。

---

## 3. 从干净 main 构建

```bash
git checkout main
git pull origin main
```

如果你刚刚清过 Murmur 本地数据，这是产品测试数据；不影响构建。

安装依赖并确认能 build：

```bash
cd app
npm install
npm run lint
npm run build
cd ..
```

---

## 4. 一键构建、签名、公证

仓库里有脚本：

```bash
./scripts/macos-notarize-release.sh
```

第一次运行前先设置环境变量：

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export NOTARY_PROFILE="murmur-notary"
```

然后从仓库根目录运行：

```bash
./scripts/macos-notarize-release.sh
```

脚本会做这些事：

1. `npm run tauri:build`
2. 清理 `.app` 的 extended attributes
3. 给 `.app` 里的 Mach-O 文件逐个 Developer ID 签名
4. 给整个 `Murmur.app` 使用 hardened runtime 签名
5. 生成 `.app.zip`
6. 提交 `.app.zip` 给 Apple 公证
7. 把公证票据装订回 `Murmur.app`
8. 重新生成带票据的 `.app.zip`
9. 生成 `.dmg`
10. 给 `.dmg` 签名
11. 提交 `.dmg` 给 Apple 公证
12. `stapler` 装订 DMG 公证票据
13. 打印 SHA256

产物在：

```text
app/src-tauri/target/release/bundle/macos/Murmur_<version>_aarch64.app.zip
app/src-tauri/target/release/bundle/dmg/Murmur_<version>_aarch64.dmg
```

如果已经 build 过，只想重新签名/公证：

```bash
SKIP_BUILD=1 ./scripts/macos-notarize-release.sh
```

---

## 5. 如果公证失败，怎么看原因

`notarytool submit --wait` 失败时会输出 submission id。拿这个 id 查日志：

```bash
xcrun notarytool log "SUBMISSION_ID" \
  --keychain-profile murmur-notary \
  notary-log.json
```

打开日志：

```bash
cat notary-log.json
```

常见错误：

| 错误 | 说明 | 修法 |
|---|---|---|
| `The binary is not signed with a valid Developer ID certificate` | 用了 ad-hoc、Apple Development、Mac Distribution，或证书没私钥 | 必须用 `Developer ID Application` |
| `The executable does not have the hardened runtime enabled` | 签名没带 `--options runtime` | 用脚本重新签 |
| nested `.dylib` / `.so` unsigned | PyInstaller 打包的 Python 动态库没签 | 脚本会逐个签 Mach-O；看漏了哪个再补 |
| Team not configured | Apple 账号/团队没开通公证能力或账号状态异常 | 去 Apple 账号后台检查，必要时联系 Apple Support |

---

## 6. 本机验证

先验证 DMG 自己：

```bash
hdiutil verify app/src-tauri/target/release/bundle/dmg/Murmur_<version>_aarch64.dmg
xcrun stapler validate app/src-tauri/target/release/bundle/dmg/Murmur_<version>_aarch64.dmg
spctl --assess --type open --context context:primary-signature --verbose=4 \
  app/src-tauri/target/release/bundle/dmg/Murmur_<version>_aarch64.dmg
```

再做一次真实下载路径测试：

1. 打开 GitHub release 页面。
2. 用 Chrome/Safari 重新下载 DMG，不要用本地旧文件。
3. 双击 DMG。
4. 拖 `Murmur.app` 到 `/Applications`。
5. 双击 `/Applications/Murmur.app`。

合格标准：

- 不出现 `damaged`。
- 不出现 `Apple could not verify`。
- 不出现只有 `Done` / `Move to Trash` 的 `"Murmur" Not Opened` 弹窗。
- 能直接打开 Murmur onboarding。
- `~/Documents/Murmur/logs/serve.log` 出现 `Murmur API listening`。

命令行再验证：

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Murmur.app
spctl --assess --type execute --verbose=4 /Applications/Murmur.app
xcrun stapler validate /Applications/Murmur.app
```

---

## 7. 上传 GitHub release

确认 SHA256：

```bash
shasum -a 256 \
  app/src-tauri/target/release/bundle/macos/Murmur_<version>_aarch64.app.zip \
  app/src-tauri/target/release/bundle/dmg/Murmur_<version>_aarch64.dmg
```

上传替换：

```bash
gh release upload v<version> \
  app/src-tauri/target/release/bundle/macos/Murmur_<version>_aarch64.app.zip \
  app/src-tauri/target/release/bundle/dmg/Murmur_<version>_aarch64.dmg \
  --clobber
```

更新 release notes，把 Mac 状态从“未公证测试包”改成“已签名并公证”。

如果 Windows 包也已经验证并上传，再把 release 从 pre-release 改成正式：

```bash
gh release edit v<version> --prerelease=false
```

---

## 8. 重要提醒

- 不要把 `.p12`、app-specific password、API key、`.p8` 放进仓库。
- 不要把证书密码写进脚本。
- 不要用 ad-hoc 包当正式 release。
- 不要只在本机 `open` 测试；必须用浏览器重新下载，因为 Gatekeeper 行为依赖 quarantine。
- 如果后续上 GitHub Actions，要把证书和密码放到 GitHub Secrets。
