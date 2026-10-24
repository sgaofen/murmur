"""Tests for the local AI CLI registry (cli/local_agents.py).

claude / codex argv and output cleaning are locked to the exact values the
pre-registry code in etcli.py / batch_analyze.py produced. gemini / kimi /
opencode are checked against the documented headless invocations.
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import local_agents  # noqa: E402

PROMPT = "# 分析包\n\n朋友 A 的聊天记录……\n"


class ArgvTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.work = Path(self._tmp.name)
        self.env = mock.patch.dict(os.environ, {}, clear=False)
        self.env.start()
        os.environ.pop("MURMUR_CODEX_MODEL", None)

    def tearDown(self) -> None:
        self.env.stop()
        self._tmp.cleanup()

    def test_registry_order(self) -> None:
        self.assertEqual(local_agents.agent_clis(), ["claude", "codex", "gemini", "kimi", "opencode"])

    def test_claude_argv_unchanged(self) -> None:
        inv = local_agents.build_invocation("claude", "/bin/claude", PROMPT, self.work)
        self.assertEqual(inv.argv, ["/bin/claude", "--print"])
        self.assertEqual(inv.stdin_text, PROMPT)
        self.assertTrue(inv.merge_stderr)
        self.assertEqual(inv.timeout, 900)
        self.assertEqual(inv.env, {})
        self.assertEqual(inv.temp_files, [])

    def test_codex_argv_unchanged(self) -> None:
        inv = local_agents.build_invocation("codex", "/bin/codex", PROMPT, self.work)
        self.assertEqual(inv.argv, ["/bin/codex", "exec", "--skip-git-repo-check", "--ephemeral",
                                    "-m", "gpt-5.2", "-"])
        self.assertEqual(inv.stdin_text, PROMPT)
        self.assertTrue(inv.merge_stderr)

    def test_codex_model_env_override(self) -> None:
        os.environ["MURMUR_CODEX_MODEL"] = " gpt-9 "
        inv = local_agents.build_invocation("codex", "codex", PROMPT, self.work)
        self.assertEqual(inv.argv, ["codex", "exec", "--skip-git-repo-check", "--ephemeral", "-m", "gpt-9", "-"])
        os.environ["MURMUR_CODEX_MODEL"] = ""
        inv = local_agents.build_invocation("codex", "codex", PROMPT, self.work)
        self.assertEqual(inv.argv, ["codex", "exec", "--skip-git-repo-check", "--ephemeral", "-"])

    def test_gemini_argv(self) -> None:
        inv = local_agents.build_invocation("gemini", "/x/gemini", PROMPT, self.work)
        self.assertEqual(inv.argv[:4], ["/x/gemini", "--output-format", "text", "-p"])
        self.assertEqual(len(inv.argv), 5)
        self.assertTrue(inv.argv[4])
        self.assertEqual(inv.stdin_text, PROMPT)
        self.assertFalse(inv.merge_stderr)

    def test_opencode_argv(self) -> None:
        inv = local_agents.build_invocation("opencode", "/x/opencode", PROMPT, self.work)
        self.assertEqual(inv.argv, ["/x/opencode", "run", "--agent", "murmur-report"])
        self.assertEqual(inv.stdin_text, PROMPT)
        self.assertFalse(inv.merge_stderr)
        self.assertEqual(inv.temp_files, [])

    def test_opencode_env_denies_all_tools(self) -> None:
        inv = local_agents.build_invocation("opencode", "/x/opencode", PROMPT, self.work)
        self.assertEqual(set(inv.env), {"OPENCODE_CONFIG_CONTENT", "OPENCODE_PERMISSION"})
        cfg = json.loads(inv.env["OPENCODE_CONFIG_CONTENT"])
        agent = cfg["agent"]["murmur-report"]
        self.assertEqual(agent["mode"], "primary")
        for perms in (cfg["permission"], agent["permission"], json.loads(inv.env["OPENCODE_PERMISSION"])):
            for key in ("*", "bash", "edit", "webfetch", "websearch", "task", "external_directory"):
                self.assertEqual(perms[key], "deny", key)
            # Nothing may be allowed or left to "ask".
            self.assertEqual(set(perms.values()), {"deny"})
        # The agent selected on argv is the locked-down one from the config.
        self.assertEqual(inv.argv[inv.argv.index("--agent") + 1], "murmur-report")
        self.assertNotIn("--auto", inv.argv)
        self.assertNotIn("--dangerously-skip-permissions", inv.argv)

    def test_kimi_prompt_goes_through_file(self) -> None:
        inv = local_agents.build_invocation("kimi", "/x/kimi", PROMPT, self.work)
        self.assertEqual(inv.argv[0], "/x/kimi")
        self.assertEqual(inv.argv[1], "--agent-file")
        self.assertEqual(inv.argv[3:6], ["--output-format", "text", "-p"])
        self.assertEqual(len(inv.argv), 7)
        self.assertIsNone(inv.stdin_text)
        self.assertFalse(inv.merge_stderr)
        self.assertEqual(len(inv.temp_files), 2)
        f = inv.temp_files[0]
        self.assertTrue(f.name.startswith(".murmur_prompt_"))
        self.assertEqual(f.parent, self.work)
        self.assertEqual(f.read_text(encoding="utf-8"), PROMPT)
        # The instruction references the file by its bare name (cwd-relative).
        self.assertIn(f.name, inv.argv[6])
        self.assertNotIn(str(self.work), inv.argv[6])
        # No cmd.exe metacharacters — .cmd shims run with shell=True on Windows.
        for arg in inv.argv[1:]:
            for ch in '&|<>^%"':
                self.assertNotIn(ch, arg)
        inv.cleanup()
        for p in inv.temp_files:
            self.assertFalse(p.exists())
        inv.cleanup()  # idempotent

    def test_kimi_agent_file_only_allows_read(self) -> None:
        inv = local_agents.build_invocation("kimi", "/x/kimi", PROMPT, self.work)
        agent_file = inv.temp_files[1]
        # Passed by bare name: kimi resolves it against its work dir (our cwd).
        self.assertEqual(inv.argv[2], agent_file.name)
        self.assertTrue(agent_file.name.startswith(".murmur_agent_"))
        self.assertEqual(agent_file.parent, self.work)
        text = agent_file.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\n"))
        front, body = text[4:].split("\n---\n", 1)
        self.assertIn("name: murmur-report", front)
        self.assertIn("description: ", front)
        tools, disallowed = _yaml_lists(front)
        self.assertEqual(tools, ["Read"])
        for t in ("Bash", "Write", "Edit", "FetchURL", "WebSearch", "Agent"):
            self.assertIn(t, disallowed)
        self.assertTrue(body.strip())
        self.assertNotIn("${", body)
        for flag in ("--yolo", "--auto", "--afk", "-y"):
            self.assertNotIn(flag, inv.argv)
        inv.cleanup()

    def test_no_auto_approve_flags_anywhere(self) -> None:
        for cli in local_agents.agent_clis():
            inv = local_agents.build_invocation(cli, "/x/" + cli, PROMPT, self.work)
            for flag in ("--yolo", "--auto", "--afk", "--dangerously-skip-permissions",
                         "--approval-mode", "--full-auto", "--dangerously-bypass-approvals-and-sandbox"):
                self.assertNotIn(flag, inv.argv, (cli, flag))
            inv.cleanup()

    def test_unknown_cli_legacy_fallback(self) -> None:
        inv = local_agents.build_invocation("mystery", "/x/mystery", PROMPT, self.work)
        self.assertEqual(inv.argv, ["/x/mystery"])
        self.assertEqual(inv.stdin_text, PROMPT)

    def test_needs_shell(self) -> None:
        with mock.patch.object(sys, "platform", "win32"):
            self.assertTrue(local_agents.needs_shell(r"C:\Users\a\AppData\Roaming\npm\gemini.CMD"))
            self.assertTrue(local_agents.needs_shell("kimi.ps1"))
            self.assertFalse(local_agents.needs_shell(r"C:\bin\kimi.exe"))
        with mock.patch.object(sys, "platform", "darwin"):
            self.assertFalse(local_agents.needs_shell("/usr/local/bin/opencode.cmd"))


def _cp(rc=0, out="", err=""):
    return subprocess.CompletedProcess(args=[], returncode=rc, stdout=out, stderr=err)


def _yaml_lists(front: str):
    """Minimal parser for the `tools:` / `disallowedTools:` block lists."""
    lists = {}
    current = None
    for line in front.splitlines():
        if line.startswith("  - ") and current is not None:
            lists[current].append(line[4:].strip())
        elif line.endswith(":"):
            current = line[:-1]
            lists[current] = []
        else:
            current = None
    return lists.get("tools"), lists.get("disallowedTools")


class DetectTest(unittest.TestCase):
    def test_detects_installed_in_registry_order(self) -> None:
        paths = {"opencode": "/b/opencode", "claude": "/b/claude", "kimi": "/b/kimi", "gemini": "/b/gemini"}
        versions = {
            "/b/claude": _cp(0, "2.1.300 (Claude Code)\n"),
            "/b/gemini": _cp(0, "0.65.0\n"),
            "/b/kimi": _cp(0, "2.3.1\n"),
            "/b/opencode": _cp(0, "1.19.4\nextra line\n"),
        }
        calls = []

        def fake_run(cmd, **kw):
            calls.append((cmd, kw))
            return versions[cmd[0]]

        with mock.patch.object(sys, "platform", "darwin"):
            found = local_agents.detect_local_agents(paths.get, run=fake_run)
        self.assertEqual([a["cli"] for a in found], ["claude", "gemini", "kimi", "opencode"])
        self.assertEqual(found[0], {"cli": "claude", "name": "Claude Code", "vendor": "anthropic",
                                    "version": "2.1.300 (Claude Code)", "path": "/b/claude"})
        self.assertEqual(found[3]["version"], "1.19.4")
        self.assertEqual({a["name"] for a in found[1:]}, {"Gemini CLI", "Kimi Code", "OpenCode"})
        for cmd, kw in calls:
            self.assertEqual(cmd[1:], ["--version"])
            self.assertFalse(kw["shell"])
            self.assertEqual(kw["timeout"], 5)

    def test_version_probe_failures(self) -> None:
        paths = {"claude": "/b/claude", "codex": "/b/codex", "gemini": "/b/gemini", "kimi": "/b/kimi"}

        def fake_run(cmd, **kw):
            if cmd[0] == "/b/claude":
                return _cp(1, "", "")            # failed and silent → skipped
            if cmd[0] == "/b/codex":
                return _cp(2, "", "codex-cli 0.153.0\n")  # nonzero but printed → kept
            if cmd[0] == "/b/gemini":
                raise subprocess.TimeoutExpired(cmd, 5)
            raise OSError("exec format error")

        found = local_agents.detect_local_agents(paths.get, run=fake_run)
        self.assertEqual([(a["cli"], a["version"]) for a in found], [("codex", "codex-cli 0.153.0")])

    def test_windows_cmd_shim_uses_shell_string(self) -> None:
        shim = r"C:\Users\a\AppData\Roaming\npm\gemini.cmd"
        seen = []

        def fake_run(cmd, **kw):
            seen.append((cmd, kw["shell"]))
            return _cp(0, "0.65.0")

        with mock.patch.object(sys, "platform", "win32"):
            found = local_agents.detect_local_agents({"gemini": shim}.get, run=fake_run)
        self.assertEqual(seen, [(f'"{shim}" --version', True)])
        self.assertEqual(found[0]["path"], shim)

    def test_nothing_installed(self) -> None:
        self.assertEqual(local_agents.detect_local_agents(lambda _c: None), [])


class CleanOutputTest(unittest.TestCase):
    CODEX_RAW = (
        "OpenAI Codex v0.153.0\n--------\nworkdir: /w\nmodel: gpt-5.2\n--------\n"
        "user\n# 分析包\n\n"
        "codex\n## 关系档案\n正文第一段\n"
        "tokens used\n12,345\n"
    )

    def test_claude_strip_only(self) -> None:
        self.assertEqual(local_agents.clean_output("claude", "\n  报告\n\n"), "报告")
        self.assertEqual(local_agents.clean_output("claude", "\n  报告\n\n", server=True), "报告")

    def test_codex_batch_cleaner(self) -> None:
        self.assertEqual(local_agents.clean_output("codex", self.CODEX_RAW), "## 关系档案\n正文第一段")
        # batch matches the FIRST banner, case-insensitively, also at offset 0
        self.assertEqual(local_agents.clean_output("codex", "Codex\nA\ncodex\nB\ntokens used 9"), "A\ncodex\nB")

    def test_codex_server_cleaner(self) -> None:
        self.assertEqual(local_agents.clean_output("codex", self.CODEX_RAW, server=True), "## 关系档案\n正文第一段")
        # server matches the LAST "\ncodex\n" and ignores one at offset 0
        self.assertEqual(local_agents.clean_output("codex", "x\ncodex\nA\ncodex\nB\ntokens used\n9", server=True), "B")
        self.assertEqual(local_agents.clean_output("codex", "codex\nA\n", server=True), "codex\nA")

    def test_kimi_unwraps_transcript_layout(self) -> None:
        raw = "• ## 关系档案\n  \n  - 要点一\n    - 子要点\n\n  结尾\n\n• 第二段\n"
        # blank-but-indented lines and real blank lines both become empty
        self.assertEqual(local_agents.clean_output("kimi", raw),
                         "## 关系档案\n\n- 要点一\n  - 子要点\n\n结尾\n\n第二段")

    def test_kimi_plain_text_passthrough(self) -> None:
        raw = "## 报告\n• 这是正文里的圆点\n普通行\n"
        self.assertEqual(local_agents.clean_output("kimi", raw), raw.strip())

    def test_gemini_drops_credential_notice(self) -> None:
        raw = "Loaded cached credentials.\n## 报告\n正文\n"
        self.assertEqual(local_agents.clean_output("gemini", raw), "## 报告\n正文")

    def test_opencode_strip(self) -> None:
        self.assertEqual(local_agents.clean_output("opencode", "\n## 报告\n正文\n"), "## 报告\n正文")


class BatchAnalyzeCallAgentTest(unittest.TestCase):
    """batch_analyze.call_agent must hand the registry argv to subprocess.run."""

    def setUp(self) -> None:
        import batch_analyze
        self.ba = batch_analyze
        self._tmp = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {"MURMUR_AGENT_WORKDIR": self._tmp.name})
        self.env.start()
        os.environ.pop("MURMUR_CODEX_MODEL", None)

    def tearDown(self) -> None:
        self.env.stop()
        self._tmp.cleanup()

    def _run(self, cli, path, stdout):
        seen = {}

        def fake_run(cmd, **kw):
            seen["cmd"] = cmd
            seen.update(kw)
            if kw.get("input") is None:
                seen["files"] = sorted(p.name for p in Path(self._tmp.name).iterdir())
            return _cp(0, stdout, "")

        with mock.patch.object(self.ba.local_agents, "run_captured", fake_run), \
                mock.patch.object(sys, "platform", "darwin"):
            ok, out = self.ba.call_agent(cli, Path(path), PROMPT, timeout=7)
        return ok, out, seen

    def test_claude(self) -> None:
        ok, out, seen = self._run("claude", "/b/claude", "报告" * 60)
        self.assertTrue(ok)
        self.assertEqual(seen["cmd"], [str(Path("/b/claude")), "--print"])
        self.assertEqual(seen["input"], PROMPT)
        self.assertEqual(seen["timeout"], 7)
        self.assertEqual(seen["cwd"], self._tmp.name)
        self.assertIsNone(seen["env"])

    def test_codex(self) -> None:
        raw = "banner\ncodex\n" + "正文" * 60 + "\ntokens used\n1"
        ok, out, seen = self._run("codex", "/b/codex", raw)
        self.assertTrue(ok)
        self.assertEqual(seen["cmd"], [str(Path("/b/codex")), "exec", "--skip-git-repo-check",
                                       "--ephemeral", "-m", "gpt-5.2", "-"])
        self.assertEqual(out, "正文" * 60)

    def test_kimi_file_is_written_then_removed(self) -> None:
        raw = "• " + "正文" * 60 + "\n"
        ok, out, seen = self._run("kimi", "/b/kimi", raw)
        self.assertTrue(ok)
        self.assertIsNone(seen["input"])
        self.assertEqual(len(seen["files"]), 2)
        agent_f, prompt_f = seen["files"]  # sorted: .murmur_agent_ < .murmur_prompt_
        self.assertTrue(prompt_f.startswith(".murmur_prompt_"))
        self.assertTrue(agent_f.startswith(".murmur_agent_"))
        self.assertIn(prompt_f, seen["cmd"][-1])
        self.assertEqual(seen["cmd"][1:3], ["--agent-file", agent_f])
        self.assertEqual(out, "正文" * 60)
        self.assertEqual(list(Path(self._tmp.name).iterdir()), [])

    def test_opencode_gets_lockdown_env(self) -> None:
        ok, out, seen = self._run("opencode", "/b/opencode", "报告" * 60)
        self.assertTrue(ok)
        self.assertEqual(seen["cmd"], [str(Path("/b/opencode")), "run", "--agent", "murmur-report"])
        env = seen["env"]
        self.assertIsNotNone(env)
        cfg = json.loads(env["OPENCODE_CONFIG_CONTENT"])
        self.assertEqual(cfg["agent"]["murmur-report"]["permission"]["bash"], "deny")
        self.assertEqual(json.loads(env["OPENCODE_PERMISSION"])["*"], "deny")
        # The rest of the user's environment is kept (PATH, API keys, ...).
        self.assertEqual(env.get("PATH"), os.environ.get("PATH"))

    def test_timeout_is_reported(self) -> None:
        def fake_run(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, kw["timeout"])

        with mock.patch.object(self.ba.local_agents, "run_captured", fake_run), \
                mock.patch.object(sys, "platform", "darwin"):
            ok, out = self.ba.call_agent("claude", Path("/b/claude"), PROMPT, timeout=7)
        self.assertFalse(ok)
        self.assertIn("TIMEOUT after 7s", out)
        self.assertEqual(list(Path(self._tmp.name).iterdir()), [])


class ProcessTreeTest(unittest.TestCase):
    """Timeouts must kill the agent and whatever it spawned."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_run_captured_ok(self) -> None:
        r = local_agents.run_captured(
            # Decode explicitly: the child's own stdin encoding is the locale
            # one (cp1252 on Windows runners) and text pipes use CRLF there.
            [sys.executable, "-c",
             "import sys; d = sys.stdin.buffer.read().decode('utf-8'); print(len(d.replace('\\r\\n', '\\n')))"],
            input=PROMPT, timeout=30, cwd=str(self.tmp), env=None)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), str(len(PROMPT)))

    def test_run_captured_timeout_kills_child(self) -> None:
        marker = self.tmp / "alive"
        code = (
            "import time, pathlib\n"
            "time.sleep(3)\n"
            f"pathlib.Path({str(marker)!r}).write_text('x')\n"
        )
        t0 = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            local_agents.run_captured([sys.executable, "-c", code], input="", timeout=0.5,
                                      cwd=str(self.tmp), env=None)
        self.assertLess(time.monotonic() - t0, 3)
        time.sleep(3.5)
        self.assertFalse(marker.exists())

    @unittest.skipIf(sys.platform.startswith("win"), "POSIX process groups")
    def test_run_captured_timeout_kills_grandchild(self) -> None:
        marker = self.tmp / "grandchild_alive"
        grandchild = (
            "import time, pathlib\n"
            "time.sleep(3)\n"
            f"pathlib.Path({str(marker)!r}).write_text('x')\n"
        )
        code = (
            "import subprocess, sys, time\n"
            f"subprocess.Popen([sys.executable, '-c', {grandchild!r}])\n"
            "time.sleep(30)\n"
        )
        with self.assertRaises(subprocess.TimeoutExpired):
            local_agents.run_captured([sys.executable, "-c", code], input="", timeout=1,
                                      cwd=str(self.tmp), env=None)
        time.sleep(3.5)
        self.assertFalse(marker.exists())

    def test_kill_process_tree_on_exited_process_is_noop(self) -> None:
        p = subprocess.Popen([sys.executable, "-c", "pass"], **local_agents.popen_group_kwargs())
        p.wait()
        local_agents.kill_process_tree(p)
        self.assertEqual(p.returncode, 0)


@unittest.skipIf(sys.platform.startswith("win"), "POSIX shebang fake agent")
class EtcliStreamingRunnerTest(unittest.TestCase):
    """End-to-end through etcli._run_local_agent_streaming with a fake CLI."""

    def setUp(self) -> None:
        import etcli
        self.etcli = etcli
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.work = self.tmp / "work"
        self.env = mock.patch.dict(os.environ, {"MURMUR_AGENT_WORKDIR": str(self.work)})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self._tmp.cleanup()

    def _fake(self, name: str, body: str) -> str:
        p = self.tmp / name
        p.write_text(f"#!{sys.executable}\nimport sys\n{body}\n", encoding="utf-8")
        p.chmod(p.stat().st_mode | stat.S_IXUSR)
        return str(p)

    def test_gemini_stderr_kept_out_of_report(self) -> None:
        agent = self._fake("gemini", (
            "data = sys.stdin.read()\n"
            "sys.stderr.write('thinking...\\n')\n"
            "print('ARGS', sys.argv[1:4])\n"
            "print('LEN', len(data))"
        ))
        state = {"output": ""}
        rc, err = self.etcli._run_local_agent_streaming("gemini", agent, PROMPT, state)
        self.assertEqual(rc, 0)
        self.assertIn("ARGS ['--output-format', 'text', '-p']", state["output"])
        self.assertIn(f"LEN {len(PROMPT)}", state["output"])
        self.assertNotIn("thinking", state["output"])
        self.assertIn("thinking...", err)

    def test_claude_stderr_still_merged(self) -> None:
        agent = self._fake("claude", "sys.stdin.read()\nsys.stderr.write('warn\\n')\nsys.stderr.flush()\nprint('ok')")
        state = {"output": ""}
        rc, err = self.etcli._run_local_agent_streaming("claude", agent, PROMPT, state)
        self.assertEqual(rc, 0)
        self.assertIn("warn", state["output"])
        self.assertIn("ok", state["output"])
        self.assertEqual(err, "")

    def test_kimi_reads_prompt_file_from_cwd(self) -> None:
        agent = self._fake("kimi", (
            "import re\n"
            "name = re.search(r'(\\.murmur_prompt_\\w+\\.md)', sys.argv[-1]).group(1)\n"
            "print('• ' + open(name, encoding='utf-8').read().splitlines()[0])"
        ))
        state = {"output": ""}
        rc, _ = self.etcli._run_local_agent_streaming("kimi", agent, PROMPT, state)
        self.assertEqual(rc, 0)
        self.assertEqual(self.etcli._local_agents.clean_output("kimi", state["output"], server=True), "# 分析包")
        self.assertEqual([p for p in self.work.iterdir() if p.name.startswith(".murmur_")], [])

    def test_kimi_agent_file_present_during_run(self) -> None:
        agent = self._fake("kimi", (
            "i = sys.argv.index('--agent-file')\n"
            "text = open(sys.argv[i + 1], encoding='utf-8').read()\n"
            "print('• ' + ('TOOLS_READ_ONLY' if 'tools:\\n  - Read\\n' in text else 'BAD'))"
        ))
        state = {"output": ""}
        rc, _ = self.etcli._run_local_agent_streaming("kimi", agent, PROMPT, state)
        self.assertEqual(rc, 0)
        self.assertIn("TOOLS_READ_ONLY", state["output"])
        self.assertEqual([p for p in self.work.iterdir() if p.name.startswith(".murmur_")], [])

    def test_opencode_receives_lockdown_env(self) -> None:
        agent = self._fake("opencode", (
            "import json, os\n"
            "sys.stdin.read()\n"
            "cfg = json.loads(os.environ['OPENCODE_CONFIG_CONTENT'])\n"
            "print('AGENT', sys.argv[sys.argv.index('--agent') + 1])\n"
            "print('BASH', cfg['agent']['murmur-report']['permission']['bash'])\n"
            "print('PERM', json.loads(os.environ['OPENCODE_PERMISSION'])['edit'])"
        ))
        state = {"output": ""}
        rc, _ = self.etcli._run_local_agent_streaming("opencode", agent, PROMPT, state)
        self.assertEqual(rc, 0)
        self.assertIn("AGENT murmur-report", state["output"])
        self.assertIn("BASH deny", state["output"])
        self.assertIn("PERM deny", state["output"])

    def test_timeout_kills_agent_and_children(self) -> None:
        marker = self.tmp / "grandchild_alive"
        grandchild = (
            "import time, pathlib\n"
            "time.sleep(3)\n"
            f"pathlib.Path({str(marker)!r}).write_text('x')\n"
        )
        # Keeps stdout open forever (the old code then never reached its
        # wait(timeout=...)) and leaves a grandchild behind.
        agent = self._fake("claude", (
            "import subprocess, time\n"
            "sys.stdin.read()\n"
            f"subprocess.Popen([sys.executable, '-c', {grandchild!r}])\n"
            "print('started', flush=True)\n"
            "time.sleep(60)\n"
        ))
        real_build = self.etcli._local_agents.build_invocation

        def short_timeout(*a, **kw):
            inv = real_build(*a, **kw)
            inv.timeout = 1
            return inv

        state = {"output": ""}
        t0 = time.monotonic()
        with mock.patch.object(self.etcli._local_agents, "build_invocation", short_timeout):
            rc, err = self.etcli._run_local_agent_streaming("claude", agent, PROMPT, state)
        self.assertLess(time.monotonic() - t0, 20)
        self.assertNotEqual(rc, 0)
        self.assertIn("超时", err)
        self.assertIn("started", state["output"])
        time.sleep(3.5)
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
