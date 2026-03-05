#!/usr/bin/env bash

input=$(cat)

# jq 调用解析所有字段
# ⬆️ 使用当前 turn 有效 input（含 cache_read + cache_creation），避免 total_input_tokens 因 prompt cache 而严重低估
# 💵 使用 cost.total_cost_usd 准确值，而非自行估算（估算会忽略 cache 费用，低估 5 倍以上）
eval "$(echo "$input" | jq -r '
  "model_name=" + (.model.display_name // "Unknown" | @sh),
  "project_dir=" + (.workspace.project_dir // .workspace.current_dir // .cwd // "" | @sh),
  "cur_input=" + (
    ((.context_window.current_usage.input_tokens // 0) +
     (.context_window.current_usage.cache_creation_input_tokens // 0) +
     (.context_window.current_usage.cache_read_input_tokens // 0)) | tostring
  ),
  "cur_output=" + (.context_window.total_output_tokens // 0 | tostring),
  "used_pct_int=" + (.context_window.used_percentage // 0 | round | tostring),
  "context_size_int=" + (.context_window.context_window_size // 0 | round | tostring),
  "transcript=" + (.transcript_path // "" | @sh),
  "cost=" + (
    ((.cost.total_cost_usd // 0) * 100 | round) as $cents |
    (($cents / 100 | floor | tostring) + "." +
     ($cents % 100 | tostring | if length == 1 then "0" + . else . end)) |
    ("$" + .) | @sh
  )
' 2>/dev/null)"

cost=${cost:-'$0.00'}

# Model label
case "$model_name" in
  *"Opus 4"*)     model_label="Opus 4.6" ;;
  *"Sonnet 4"*)   model_label="Sonnet 4.6" ;;
  *"Haiku 4"*)    model_label="Haiku 4.6" ;;
  *"Opus 3.7"*)   model_label="Opus 3.7" ;;
  *"Sonnet 3.7"*) model_label="Sonnet 3.7" ;;
  *"Sonnet 3.5"*) model_label="Sonnet 3.5" ;;
  *"Haiku 3.5"*)  model_label="Haiku 3.5" ;;
  *)              model_label="$model_name" ;;
esac

# Project & Git branch
project=$(basename "$project_dir")
git_branch=$(git -C "$project_dir" --no-optional-locks branch --show-current 2>/dev/null)
[ -z "$git_branch" ] && git_branch="(no branch)"

# Token 格式化（>= 1000 显示 k 后缀）
fmt_tokens() {
  local n=$1
  if [ "$n" -ge 1000 ] 2>/dev/null; then
    printf "%dk" $(( n / 1000 ))
  else
    printf "%d" "$n"
  fi
}

input_fmt=$(fmt_tokens "$cur_input")
output_fmt=$(fmt_tokens "$cur_output")
ctx_used_fmt=$(fmt_tokens $(( used_pct_int * context_size_int / 100 )))
ctx_max_fmt=$(fmt_tokens "$context_size_int")

# Duration：从 transcript 文件创建时间起算
# 必须用 birth time（%W/%B），mtime 每次写入都会刷新
duration_str="0m 0s"
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  start_epoch=$(stat -c %W "$transcript" 2>/dev/null || stat -f %B "$transcript" 2>/dev/null)
  if [ -n "$start_epoch" ]; then
    elapsed=$(( $(date +%s) - start_epoch ))
    [ "$elapsed" -lt 0 ] && elapsed=0
    duration_str="$(( elapsed / 60 ))m $(( elapsed % 60 ))s"
  fi
fi

# 颜色定义（True color 24-bit ANSI）
RESET='\033[0m'
C_BAR_FILL='\033[38;2;65;160;41m'   # #41a029
C_BAR_BG='\033[38;2;199;222;197m'   # #c7dec5
C_MODEL='\033[38;2;0;142;139m'      # #008e8b
C_COST='\033[38;2;209;131;0m'       # #d18300
C_BRANCH='\033[38;2;41;104;216m'    # #2968d8
C_PROJECT='\033[38;2;34;226;152m'   # #22e298
C_TIME='\033[38;2;221;115;221m'     # #dd73dd
C_NET='\033[38;2;255;200;0m'        # #ffc800

# 进度条（9 格，填充与背景仅颜色不同）
bar_filled=$(( used_pct_int * 9 / 100 ))
[ "$bar_filled" -gt 9 ] && bar_filled=9
bar=""
for i in $(seq 1 "$bar_filled");         do bar="${bar}${C_BAR_FILL}█${RESET}"; done
for i in $(seq 1 $(( 9 - bar_filled ))); do bar="${bar}${C_BAR_BG}█${RESET}"; done

printf "🚀 ${C_MODEL}%b${RESET} | 🗃️ ${C_PROJECT}%s${RESET} | ✏️ ${C_BRANCH}%s${RESET} | ⬆️${C_NET}%s${RESET} ⬇️${C_NET}%s${RESET}\n" \
  "$model_label" "$project" "$git_branch" "$input_fmt" "$output_fmt"

printf "📖 %b %s%% (%s/%s) | 💵 ${C_COST}%s${RESET} | ⏰ ${C_TIME}%s${RESET}\n" \
  "$bar" "$used_pct_int" "$ctx_used_fmt" "$ctx_max_fmt" "$cost" "$duration_str"
