#!/bin/bash
# Unguibus message hook — runs after each Claude response
# Checks if the current session has pending messages

python3 -c "
import sys, json, urllib.request

try:
    data = json.load(sys.stdin)
    session_id = data.get('session_id', '')
    if not session_id:
        sys.exit(0)

    req = urllib.request.Request(f'http://localhost:7272/agents/{session_id}/inbox')
    with urllib.request.urlopen(req, timeout=2) as resp:
        messages = json.loads(resp.read())

    if not messages or not isinstance(messages, list) or len(messages) == 0:
        sys.exit(0)

    formatted = '\n'.join(f'From {m[\"from\"]}: {m[\"body\"]}' for m in messages)
    count = len(messages)

    print(json.dumps({
        'additionalContext': f'You have {count} new message(s) from the unguibus agent network:\n\n{formatted}\n\nUse send_message to reply if needed.'
    }))
except:
    sys.exit(0)
"
