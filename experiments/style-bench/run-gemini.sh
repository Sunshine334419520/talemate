#!/usr/bin/env bash
# 用 Gemini 的 OpenAI 兼容层跑文风测试台。
#
# key 只从环境或 .env.gemini 读，不写进 .env；跑完删掉 .env.gemini 即可回到原配置。
# 用法：
#   GEMINI_API_KEY=... bun run style-bench:gemini --case 05-high-stakes --config storytelling-base --samples 3
# 或：
#   echo 'GEMINI_API_KEY=...' > .env.gemini
#   bun run style-bench:gemini --dry-run
set -euo pipefail

if [ -f .env.gemini ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.gemini
  set +a
fi

: "${GEMINI_API_KEY:?请先 export GEMINI_API_KEY 或写入 .env.gemini}"

TALEMATE_PROVIDER=openai \
TALEMATE_API_BASE="${GEMINI_API_BASE:-https://generativelanguage.googleapis.com/v1beta/openai/}" \
TALEMATE_API_KEY="$GEMINI_API_KEY" \
TALEMATE_MODEL="${GEMINI_MODEL:-gemini-3.8-flash}" \
TALEMATE_REASONING="${GEMINI_REASONING:-low}" \
TALEMATE_TEMPERATURE="${GEMINI_TEMPERATURE:-0.8}" \
bun run experiments/style-bench/run.ts "$@"
