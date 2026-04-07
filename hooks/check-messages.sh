#!/bin/bash
# Unguibus message hook — runs after each Claude response
# Checks if the current session has pending messages, delivers them, then acks

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
    max_ts = max(m['timestamp'] for m in messages)

    # Ack the messages
    ack_req = urllib.request.Request(
        f'http://localhost:7272/agents/{session_id}/inbox/ack',
        data=json.dumps({'timestamp': max_ts}).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    urllib.request.urlopen(ack_req, timeout=2)

    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'Stop',
            'additionalContext': f'You have {count} new message(s) from the unguibus agent network:\n\n{formatted}\n\nUse send_message to reply if needed.'
        }
    }))
except:
    sys.exit(0)
"
