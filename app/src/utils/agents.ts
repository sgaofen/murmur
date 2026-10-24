// Display metadata for the local AI CLIs the backend can drive
// (cli/local_agents.py AGENTS). The backend's /api/agents is the source of
// truth for what is installed; this only covers labels for UI text.

export const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  kimi: 'Kimi Code',
  opencode: 'OpenCode',
};

export function agentDisplayName(cli: string): string {
  return AGENT_LABELS[cli] || cli;
}

// One-line description shown under each agent in pickers.
export function agentBlurb(cli: string): string {
  switch (cli) {
    case 'claude': return '我电脑上的 Claude，最聪明的助手';
    case 'codex': return 'OpenAI 出的命令行助手';
    case 'gemini': return 'Google 的 Gemini 命令行助手';
    case 'kimi': return '月之暗面 Kimi 的命令行助手';
    case 'opencode': return '开源命令行助手，可接多家模型';
    default: return '本机 AI 工具';
  }
}

// Shown when nothing is detected.
export const AGENT_CLI_LIST = 'Claude Code / Codex / Gemini / Kimi / OpenCode';
