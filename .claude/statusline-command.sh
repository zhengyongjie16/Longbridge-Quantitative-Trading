#!/usr/bin/env bash

# Read JSON input from stdin
input=$(cat)

# --- Model ---
model_name=$(echo "$input" | jq -r '.model.display_name // "Unknown"')
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

# --- Project (basename of project_dir, fallback to cwd) ---
project_dir=$(echo "$input" | jq -r '.workspace.project_dir // .workspace.current_dir // .cwd // ""')
project=$(basename "$project_dir")

# --- Git branch (skip optional locks to avoid contention) ---
git_branch=$(git -C "$project_dir" --no-optional-locks branch --show-current 2>/dev/null)
[ -z "$git_branch" ] && git_branch="(no branch)"

# --- Token counts ---
total_input=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
total_output=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')

# Format number with k suffix when >= 1000
fmt_tokens() {
  local n=$1
  if [ "$n" -ge 1000 ] 2>/dev/null; then
    printf "%dk" $(( n / 1000 ))
  else
    printf "%d" "$n"
  fi
}

input_fmt=$(fmt_tokens "$total_input")
output_fmt=$(fmt_tokens "$total_output")

# --- Context window ---
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // 0')
context_size=$(echo "$input" | jq -r '.context_window.context_window_size // 0')
current_input=$(echo "$input" | jq -r '.context_window.current_usage.input_tokens // 0')

ctx_used_fmt=$(fmt_tokens "$current_input")
ctx_max_fmt=$(fmt_tokens "$context_size")

# Round percentage to integer
used_pct_int=$(printf "%.0f" "$used_pct" 2>/dev/null || echo "0")

# True color definitions (24-bit ANSI)
RESET='\033[0m'
C_BAR_FILL='\033[38;2;65;160;41m'   # #41a029 进度条填充色
C_BAR_BG='\033[38;2;199;222;197m'   # #c7dec5 进度条背景色

# Progress bar: 9 blocks wide，填充与背景均用 █，仅颜色不同（无砂纸感）
bar_filled=$(( used_pct_int * 9 / 100 ))
[ "$bar_filled" -gt 9 ] && bar_filled=9
bar_empty=$(( 9 - bar_filled ))
bar=""
for i in $(seq 1 "$bar_filled"); do bar="${bar}${C_BAR_FILL}█${RESET}"; done
for i in $(seq 1 "$bar_empty");  do bar="${bar}${C_BAR_BG}█${RESET}"; done

# --- Cost: approximate from cumulative token totals ---
# Opus 4 pricing: input $3/M, output $15/M
cost=$(echo "$input" | jq -r '
  (.context_window.total_input_tokens // 0) as $in |
  (.context_window.total_output_tokens // 0) as $out |
  (($in * 3 + $out * 15) / 1000000) |
  . * 100 | round | . / 100 |
  "$" + (tostring | if test("\\.") then . else . + ".00" end)
' 2>/dev/null || echo '$0.00')

# --- Duration: elapsed time since transcript file was last modified ---
transcript=$(echo "$input" | jq -r '.transcript_path // ""')
duration_str="0m 0s"
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  start_epoch=$(stat -c %Y "$transcript" 2>/dev/null || stat -f %m "$transcript" 2>/dev/null)
  now_epoch=$(date +%s)
  if [ -n "$start_epoch" ] && [ -n "$now_epoch" ]; then
    elapsed=$(( now_epoch - start_epoch ))
    [ "$elapsed" -lt 0 ] && elapsed=0
    dur_min=$(( elapsed / 60 ))
    dur_sec=$(( elapsed % 60 ))
    duration_str="${dur_min}m ${dur_sec}s"
  fi
fi
# --- Render ---
C_MODEL='\033[38;2;0;142;139m'    # #008e8b 模型名颜色
C_COST='\033[38;2;209;131;0m'     # #d18300 金额颜色
C_BRANCH='\033[38;2;41;104;216m'  # #2968d8 分支名颜色
C_PROJECT='\033[38;2;34;226;152m' # #22e298 项目名颜色
C_TIME='\033[38;2;221;115;221m'   # #dd73dd 时间颜色

printf "🚀 ${C_MODEL}%b${RESET} | 🗃️ ${C_PROJECT}%s${RESET} | 🚩 ${C_BRANCH}%s${RESET} | ⬆️%s ⬇️%s\n" \
  "$model_label" "$project" "$git_branch" "$input_fmt" "$output_fmt"

printf "%b %s%% (%s/%s) | ${C_COST}%s${RESET} | ⏰ ${C_TIME}%s${RESET}\n" \
  "$bar" "$used_pct_int" "$ctx_used_fmt" "$ctx_max_fmt" "$cost" "$duration_str"
