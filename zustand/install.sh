#!/usr/bin/env bash
# Installs the zustand skill into every supported AI coding agent found on
# this machine. Re-run after pulling updates.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$SRC/SKILL.md" ]]; then
  echo "ERROR: SKILL.md not found next to install.sh" >&2
  exit 1
fi

# Candidate skills directories, installed only if the parent tool dir exists.
CANDIDATES=(
  "$HOME/.claude/skills"            # Claude Code
  "$HOME/.codex/skills"             # Codex CLI
  "$HOME/.cursor/skills"            # Cursor
  "$HOME/.copilot/skills"           # GitHub Copilot CLI
  "$HOME/.codeium/windsurf/skills"  # Windsurf
  "$HOME/.gemini/skills"            # Gemini CLI
  "$HOME/.config/opencode/skills"   # opencode
  "$HOME/.opencode/skills"          # opencode (legacy layout)
  "$HOME/.qwen/skills"              # Qwen Code
  "$HOME/.openclaude/skills"        # OpenClaude
  "$HOME/.zcode/skills"             # ZCode
)

installed=0
for skills_dir in "${CANDIDATES[@]}"; do
  tool_dir="$(dirname "$skills_dir")"
  [[ -d "$tool_dir" ]] || continue
  target="$skills_dir/zustand"
  mkdir -p "$target"
  rsync -a --delete \
    --exclude '.git' --exclude 'evals' --exclude 'install.sh' \
    --exclude 'README.md' --exclude 'LICENSE' \
    "$SRC/" "$target/"
  echo "installed -> $target"
  installed=$((installed + 1))
done

if [[ $installed -eq 0 ]]; then
  echo "No supported agent tools found. Copy SKILL.md and references/ into"
  echo "your tool's skills directory manually."
  exit 1
fi

echo "Done: installed to $installed location(s)."
