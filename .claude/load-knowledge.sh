#!/usr/bin/env bash
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
files=(
  "knowledge-base/about-me.md"
  "knowledge-base/architecture-principles.md"
  "knowledge-base/coding-standards.md"
  "knowledge-base/review-checklist.md"
  "knowledge-base/project/context/architecture.md"
  "knowledge-base/project/context/dev.md"
)
ctx=""
for f in "${files[@]}"; do
  fp="$root/$f"
  [[ -f "$fp" ]] && ctx+="$(printf '\n\n## %s\n\n' "$f")$(cat "$fp")"
done

pending="$root/.claude/kb-pending.md"
if [[ -f "$pending" ]]; then
  ctx+="$(printf '\n\n## ACTION REQUIRED AT SESSION START\n\nThe last session changed source files. Update the relevant knowledge-base files at knowledge-base/project/context/ based on the changes below, then delete the file .claude/kb-pending.md.\n\n')$(cat "$pending")"
fi

printf '%s' "$ctx" | jq -Rs '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": .}}'
