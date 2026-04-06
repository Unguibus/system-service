#!/bin/bash
# Unguibus message hook — runs after each Claude response
# Checks if the current session has pending messages

SESSION_ID=$(cat | jq -r '.session_id // empty')
if [ -z "$SESSION_ID" ]; then exit 0; fi

# Check inbox for this session/agent
RESPONSE=$(curl -s "http://localhost:7272/agents/$SESSION_ID/inbox" 2>/dev/null)
if [ -z "$RESPONSE" ] || [ "$RESPONSE" = "[]" ] || echo "$RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
  exit 0
fi

COUNT=$(echo "$RESPONSE" | jq 'length')
if [ "$COUNT" = "0" ]; then exit 0; fi

# Format messages for Claude
FORMATTED=$(echo "$RESPONSE" | jq -r '.[] | "From \(.from): \(.body)"' 2>/dev/null)

# Return additionalContext so Claude sees the messages
jq -n --arg msgs "$FORMATTED" --arg count "$COUNT" '{
  "additionalContext": ("You have " + $count + " new message(s) from the unguibus agent network:\n\n" + $msgs + "\n\nUse send_message to reply if needed.")
}'
