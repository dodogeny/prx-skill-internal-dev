#!/bin/bash
ENV_FILE="/Users/javed.neemuth/Documents/Prevoir/Development/Playground/prx-skill-internal-dev/.env"
if [ ! -f "$ENV_FILE" ]; then exit 0; fi

python3 - "$ENV_FILE" <<'PYEOF'
import json, sys, re

env_file = sys.argv[1]
lines = []
with open(env_file) as f:
    for line in f:
        line = line.rstrip()
        if line and not line.startswith('#'):
            lines.append(line)

content = "\n".join(lines)
output = {
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": f"Project .env loaded:\n{content}"
    }
}
print(json.dumps(output))
PYEOF
