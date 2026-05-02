# Agent Sync Notes - Windows Side

Last synchronized: 2026-05-02.

Windows-specific work that Mac should preserve:

- Keep `build-windows.ps1` as the first-class Windows release build entrypoint.
- Keep `pycryptodome` in the shared dependency path unless Windows gets a
  separate requirements file; Windows image `.dat` AES decrypt needs
  `Crypto.Cipher.AES`.
- Windows key extraction hooks the running Weixin/WeChat process and then waits
  for a fresh login event. The UI should tell users to keep WeChat running,
  start the hook, then log out and log back in.
- Detect both `Weixin.exe` and `WeChat.exe`, including Tencent registry keys and
  32-bit/64-bit install paths.
- Do not generate pair LLM reports from co-group-only evidence. Shared group
  membership can appear in the graph, but pair reports need direct evidence such
  as mutual replies, mentions, or Moments interaction.
- Keep pair report lookup based on stable `wxid_a` / `wxid_b` metadata, not body
  text matching.

Mac-specific work that Windows should preserve when porting:

- Tauri dev URLs and backend URLs should prefer `127.0.0.1` over `localhost`.
- The packaged app should bundle the PyInstaller backend so ordinary users do
  not need Python or Node.
- Relationship graph pointer coordinates should use SVG screen transforms so
  click targets stay aligned under CSS/viewBox scaling.
- Selected graph edges should stay highlighted without clearing the selected
  friend network.
