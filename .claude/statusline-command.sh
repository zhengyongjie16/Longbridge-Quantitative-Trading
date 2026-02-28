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

# Progress bar: 9 blocks wide
bar_filled=$(( used_pct_int * 9 / 100 ))
[ "$bar_filled" -gt 9 ] && bar_filled=9
bar_empty=$(( 9 - bar_filled ))
bar=""
for i in $(seq 1 "$bar_filled"); do bar="${bar}█"; done
for i in $(seq 1 "$bar_empty");  do bar="${bar}░"; done

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

# --- Git diff stats against HEAD ---
git_stats=$(git -C "$project_dir" --no-optional-locks diff --shortstat HEAD 2>/dev/null)
[ -z "$git_stats" ] && git_stats=$(git -C "$project_dir" --no-optional-locks diff --shortstat 2>/dev/null)

diff_files=0
diff_ins=0
diff_del=0
if [ -n "$git_stats" ]; then
  diff_files=$(echo "$git_stats" | grep -oP '\d+(?= file)'      | head -1 || echo 0)
  diff_ins=$(echo "$git_stats"   | grep -oP '\d+(?= insertion)' | head -1 || echo 0)
  diff_del=$(echo "$git_stats"   | grep -oP '\d+(?= deletion)'  | head -1 || echo 0)
fi

# --- Render three lines ---
printf "[%s] 📁 %s | 🌿 %s | ↑%s ↓%s\n" \
  "$model_label" "$project" "$git_branch" "$input_fmt" "$output_fmt"

printf "[%s] %s%% (%s/%s) | %s | ⏱ %s\n" \
  "$bar" "$used_pct_int" "$ctx_used_fmt" "$ctx_max_fmt" "$cost" "$duration_str"

printf "%s files +%s -%s\n" \
  "$diff_files" "$diff_ins" "$diff_del"
