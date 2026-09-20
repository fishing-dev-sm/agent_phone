#!/bin/sh
# Install the phone-report skill for Kimi Code and Codex CLI (idempotent).
set -eu
skill_src=$(CDPATH= cd -- "$(dirname -- "$0")/phone-report" && pwd)

install_link() {
  target_dir=$1
  if [ ! -d "$target_dir" ]; then
    echo "skip: $target_dir 不存在（对应 agent 未安装）"
    return
  fi
  link="$target_dir/phone-report"
  if [ -L "$link" ] || [ -e "$link" ]; then rm -rf "$link"; fi
  ln -s "$skill_src" "$link"
  echo "installed: $link -> $skill_src"
}

install_link "${KIMI_SKILLS_DIR:-$HOME/.agents/skills}"
install_link "${CODEX_HOME:-$HOME/.codex}/skills"
echo '完成。请确认 agent 侧能发现 phone-report skill（Kimi 新会话生效；Codex /skills 查看）。'
