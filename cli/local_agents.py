"""Registry of local AI coding CLIs that Murmur can drive non-interactively.

Each entry says how to detect the CLI, how to build its non-interactive argv,
how the prompt (an analysis pack, often 50-200 KB of markdown) is fed in, and
how to pull the final report text out of its stdout.

claude / codex are the original two agents; their argv and output cleaning
must stay byte-for-byte identical to the pre-registry code (locked by
tests/test_local_agents.py). gemini / kimi / opencode were added from the
vendors' documented headless modes and have NOT been run against real CLIs
by the author of this module.

Stdlib only: imported by etcli.py, batch_analyze.py and the unit tests, none
of which may pull third-party packages at import time.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional

# How the prompt reaches the CLI.
PROMPT_STDIN = "stdin"  # whole pack piped on stdin
PROMPT_FILE = "file"    # pack written to a file in cwd, short instruction on argv

DEFAULT_TIMEOUT = 900

# Instruction passed on argv when the pack goes through a file. Keep it free of
# cmd.exe metacharacters (& | < > ^ % ") — on Windows .cmd shims are run with
# shell=True and this string ends up inside double quotes on the command line.
FILE_PROMPT_TEMPLATE = (
    "请完整读取当前目录下的文件 {name} ，它是一份 UTF-8 Markdown 分析材料。"
    "严格按照文件里的要求，直接输出最终报告正文。"
    "不要修改或创建任何文件，也不要复述读取过程。"
)


def codex_model_args() -> List[str]:
    model = os.environ.get("MURMUR_CODEX_MODEL", "gpt-5.2").strip()
    return ["-m", model] if model else []


# ---------------- output cleaners ----------------

def _clean_plain(output: str) -> str:
    return (output or "").strip()


def _clean_codex_batch(output: str) -> str:
    """batch_analyze.py's codex cleaner: first `codex` banner line → `tokens used`."""
    out = (output or "").strip()
    banner = re.search(r"(?:^|\n)codex\s*\n", out, flags=re.IGNORECASE)
    if banner:
        out = out[banner.end():]
    tokens = re.search(r"\ntokens used\b", out, flags=re.IGNORECASE)
    if tokens:
        out = out[:tokens.start()]
    return out.strip()


def _clean_codex_server(output: str) -> str:
    """etcli invoke / invoke-pair codex cleaner: last "\\ncodex\\n" → "\\ntokens used\\n"."""
    clean = output
    cidx = output.rfind("\ncodex\n")
    if cidx > 0:
        clean = output[cidx + len("\ncodex\n"):]
        tidx = clean.find("\ntokens used\n")
        if tidx > 0:
            clean = clean[:tidx]
    return clean.strip()


_GEMINI_NOISE = re.compile(r"^(Loaded cached credentials\.|Data collection is disabled\.)\s*$")


def _clean_gemini(output: str) -> str:
    # `gemini -p` (text format) prints only the model response on stdout; older
    # builds sometimes leaked a credentials notice there — drop those lines.
    lines = [ln for ln in (output or "").splitlines() if not _GEMINI_NOISE.match(ln.strip())]
    return "\n".join(lines).strip()


def _clean_kimi(output: str) -> str:
    """Undo Kimi Code's print-mode transcript layout.

    `kimi -p` (text format) writes each assistant block as "• first line" with
    every continuation line indented by two spaces (blank lines stay empty).
    Only unwrap when the whole output follows that layout, so plain text from
    an older / different `kimi` binary is passed through untouched.
    """
    text = (output or "").strip("\n")
    lines = text.splitlines()
    non_empty = [ln for ln in lines if ln.strip()]
    if not non_empty or not non_empty[0].startswith("• "):
        return text.strip()
    if not all(ln.startswith("• ") or ln.startswith("  ") for ln in non_empty):
        return text.strip()
    return "\n".join(ln[2:] if ln.strip() else "" for ln in lines).strip()


# ---------------- registry ----------------

@dataclass(frozen=True)
class AgentSpec:
    cli: str                 # executable name looked up on PATH
    name: str                # display name
    vendor: str
    args: Callable[[Optional[str]], List[str]]  # argv after the executable; gets the instruction for PROMPT_FILE
    prompt_via: str = PROMPT_STDIN
    # True: stderr is merged into the streamed stdout (legacy claude/codex
    # behaviour). False: stderr is kept apart so thinking / progress lines
    # never end up in the saved report.
    merge_stderr: bool = False
    clean: Callable[[str], str] = _clean_plain
    # Server (invoke / invoke-pair) cleaner when it differs from the batch one.
    clean_server: Optional[Callable[[str], str]] = None
    version_args: tuple = ("--version",)
    timeout: int = DEFAULT_TIMEOUT
    env: dict = field(default_factory=dict)


AGENTS: List[AgentSpec] = [
    AgentSpec(
        cli="claude", name="Claude Code", vendor="anthropic",
        args=lambda _i: ["--print"],
        merge_stderr=True,
    ),
    AgentSpec(
        cli="codex", name="Codex CLI", vendor="openai",
        args=lambda _i: ["exec", "--skip-git-repo-check", "--ephemeral", *codex_model_args(), "-"],
        merge_stderr=True,
        clean=_clean_codex_batch,
        clean_server=_clean_codex_server,
    ),
    # Gemini CLI headless: stdin is the input and `-p` is appended to it.
    # Default approval mode — a report needs no tools, and anything that would
    # need confirmation is refused in non-interactive mode.
    AgentSpec(
        cli="gemini", name="Gemini CLI", vendor="google",
        args=lambda _i: ["--output-format", "text", "-p", "请根据以上材料中的要求，直接输出最终报告正文。"],
        clean=_clean_gemini,
    ),
    # Kimi Code CLI (@moonshot-ai/kimi-code): print mode takes the prompt only
    # on argv, which can't carry a 100 KB pack (Linux caps one arg at 128 KB,
    # cmd.exe at 8 KB). So the pack goes to a file and the model reads it.
    AgentSpec(
        cli="kimi", name="Kimi Code", vendor="moonshot",
        args=lambda instr: ["--output-format", "text", "-p", instr or ""],
        prompt_via=PROMPT_FILE,
        clean=_clean_kimi,
    ),
    # OpenCode: `opencode run` reads piped stdin as the message (V1 1.x and
    # V2 2.x). Default format prints text parts on stdout, tool / step chrome
    # on stderr. No --auto: permission requests are auto-rejected.
    AgentSpec(
        cli="opencode", name="OpenCode", vendor="opencode",
        args=lambda _i: ["run"],
    ),
]

_BY_CLI = {a.cli: a for a in AGENTS}


def agent_clis() -> List[str]:
    return [a.cli for a in AGENTS]


def get_spec(cli: str) -> Optional[AgentSpec]:
    return _BY_CLI.get(cli)


def needs_shell(agent_path: str) -> bool:
    """Windows npm shims (.cmd/.bat/.ps1) must go through the shell."""
    return sys.platform.startswith("win") and str(agent_path).lower().endswith((".cmd", ".bat", ".ps1"))


# ---------------- detection ----------------

def detect_local_agents(
    which: Callable[[str], Optional[str]],
    run: Callable[..., "subprocess.CompletedProcess"] = subprocess.run,
) -> List[dict]:
    """Return installed agents in registry order.

    `which` resolves a command name to a path (etcli._which, which also knows
    Windows npm shims and the PATH-less .app case). An agent counts as
    installed when `<cli> --version` exits 0 or prints something.
    """
    found = []
    for spec in AGENTS:
        path = which(spec.cli)
        if not path:
            continue
        try:
            use_shell = needs_shell(path)
            if use_shell:
                cmd = " ".join([f'"{path}"', *spec.version_args])
            else:
                cmd = [path, *spec.version_args]
            r = run(cmd, capture_output=True, text=True, timeout=5,
                    encoding="utf-8", errors="replace", shell=use_shell)
            version = (r.stdout or r.stderr or "").strip().split("\n")[0][:80]
            if r.returncode == 0 or version:
                found.append({"cli": spec.cli, "name": spec.name, "vendor": spec.vendor,
                              "version": version, "path": path})
        except (subprocess.TimeoutExpired, OSError):
            pass
    return found


# ---------------- invocation ----------------

@dataclass
class Invocation:
    argv: List[str]
    stdin_text: Optional[str]
    merge_stderr: bool
    timeout: int
    env: dict
    temp_files: List[Path] = field(default_factory=list)

    def cleanup(self) -> None:
        for p in self.temp_files:
            try:
                p.unlink()
            except OSError:
                pass


def build_invocation(cli: str, agent_path: str, prompt: str, work_dir: Path) -> Invocation:
    """argv + stdin for one non-interactive run of `cli` on `prompt`.

    For PROMPT_FILE agents the pack is written into `work_dir` (the agent's
    cwd) under a random name; call `Invocation.cleanup()` when done.
    """
    spec = _BY_CLI.get(cli)
    if spec is None:
        # Unknown CLI: legacy fallback — bare executable, prompt on stdin.
        return Invocation([str(agent_path)], prompt, True, DEFAULT_TIMEOUT, {})
    temp_files: List[Path] = []
    instruction = None
    stdin_text: Optional[str] = prompt
    if spec.prompt_via == PROMPT_FILE:
        fname = f".murmur_prompt_{uuid.uuid4().hex[:12]}.md"
        fpath = Path(work_dir) / fname
        fpath.write_text(prompt, encoding="utf-8")
        temp_files.append(fpath)
        instruction = FILE_PROMPT_TEMPLATE.format(name=fname)
        stdin_text = None
    argv = [str(agent_path), *spec.args(instruction)]
    return Invocation(argv, stdin_text, spec.merge_stderr, spec.timeout, dict(spec.env), temp_files)


def clean_output(cli: str, output: str, server: bool = False) -> str:
    """Final report text from an agent's stdout.

    `server=True` selects the cleaner etcli's invoke / invoke-pair endpoints
    have always used (differs from batch_analyze.py only for codex).
    """
    spec = _BY_CLI.get(cli)
    if spec is None:
        return (output or "").strip()
    fn = (spec.clean_server or spec.clean) if server else spec.clean
    return fn(output)
