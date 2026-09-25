#!/usr/bin/env bash
project="/Users/mac/Desktop/oss/context"
pending="$project/.claude/kb-pending.md"
marker="$project/.claude/kb-last-commit"

current_head=$(git -C "$project" rev-parse HEAD 2>/dev/null)
last_processed=$(cat "$marker" 2>/dev/null)

committed=""
if [[ -n "$current_head" && "$current_head" != "$last_processed" && -n "$last_processed" ]]; then
  committed=$(git -C "$project" diff "${last_processed}..HEAD" --name-only -- app/ knowledge-base/ 2>/dev/null)
fi

uncommitted=$(git -C "$project" diff --name-only -- app/ knowledge-base/ 2>/dev/null)
uncommitted+=$'\n'$(git -C "$project" diff --cached --name-only -- app/ knowledge-base/ 2>/dev/null)

changed=$(printf '%s\n%s' "$committed" "$uncommitted" | sort -u | grep -v '^$')
[[ -z "$changed" ]] && { [[ -n "$current_head" ]] && echo "$current_head" > "$marker"; exit 0; }

log=$(git -C "$project" log --oneline -3 2>/dev/null)
printf "Recent commits:\n%s\n\nChanged files (committed + uncommitted):\n%s\n" "$log" "$changed" > "$pending"
[[ -n "$current_head" ]] && echo "$current_head" > "$marker"
