#!/usr/bin/env bash
root="/Users/mac/Desktop/oss/context"
pending="$root/.claude/kb-pending.md"
[[ ! -f "$pending" ]] && exit 0

msg="$(printf 'ACTION REQUIRED: The last session changed source files. Update the relevant knowledge-base files at knowledge-base/project/context/ based on the changes below, then delete .claude/kb-pending.md.\n\n'; cat "$pending")"

printf '%s' "$msg" | jq -Rs '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": .}}'
