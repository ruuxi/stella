#!/bin/bash
# Template: Authenticated Session Workflow
# Purpose: Login once, save state, reuse for subsequent runs
# Usage: ./authenticated-session.sh <login-url> [state-file]
#
# Environment variables:
#   APP_USERNAME - Login username/email
#   APP_PASSWORD - Login password
#
# Two modes:
#   1. Discovery mode (default): Shows form structure so you can identify refs
#   2. Login mode: Performs actual login after you update the refs
#
# Setup steps:
#   1. Run once to see form structure (discovery mode)
#   2. Update refs in LOGIN FLOW section below
#   3. Set APP_USERNAME and APP_PASSWORD
#   4. Delete the DISCOVERY section

set -euo pipefail

LOGIN_URL="${1:?Usage: $0 <login-url> [state-file]}"
STATE_FILE="${2:-./auth-state.json}"

echo "Authentication workflow: $LOGIN_URL"

# ================================================================
# SAVED STATE: Skip login if valid saved state exists
# ================================================================
if [[ -f "$STATE_FILE" ]]; then
    echo "Loading saved state from $STATE_FILE..."
    stella-browser state load "$STATE_FILE"
    stella-browser open "$LOGIN_URL"
    stella-browser wait --load networkidle

    CURRENT_URL=$(stella-browser get url)
    if [[ "$CURRENT_URL" != *"login"* ]] && [[ "$CURRENT_URL" != *"signin"* ]]; then
        echo "Session restored successfully"
        stella-browser snapshot -i
        exit 0
    fi
    echo "Session expired, performing fresh login..."
    rm -f "$STATE_FILE"
fi

# ================================================================
# DISCOVERY MODE: Shows form structure (delete after setup)
# ================================================================
echo "Opening login page..."
stella-browser open "$LOGIN_URL"
stella-browser wait --load networkidle

echo ""
echo "Login form structure:"
echo "---"
stella-browser snapshot -i
echo "---"
echo ""
echo "Next steps:"
echo "  1. Note the refs: username=@e?, password=@e?, submit=@e?"
echo "  2. Update the LOGIN FLOW section below with your refs"
echo "  3. Set: export APP_USERNAME='...' APP_PASSWORD='...'"
echo "  4. Delete this DISCOVERY MODE section"
echo ""
stella-browser close
exit 0

# ================================================================
# LOGIN FLOW: Uncomment and customize after discovery
# ================================================================
# : "${APP_USERNAME:?Set APP_USERNAME environment variable}"
# : "${APP_PASSWORD:?Set APP_PASSWORD environment variable}"
#
# stella-browser open "$LOGIN_URL"
# stella-browser wait --load networkidle
# stella-browser snapshot -i
#
# # Fill credentials (update refs to match your form)
# stella-browser fill @e1 "$APP_USERNAME"
# stella-browser fill @e2 "$APP_PASSWORD"
# stella-browser click @e3
# stella-browser wait --load networkidle
#
# # Verify login succeeded
# FINAL_URL=$(stella-browser get url)
# if [[ "$FINAL_URL" == *"login"* ]] || [[ "$FINAL_URL" == *"signin"* ]]; then
#     echo "Login failed - still on login page"
#     stella-browser screenshot /tmp/login-failed.png
#     stella-browser close
#     exit 1
# fi
#
# # Save state for future runs
# echo "Saving state to $STATE_FILE"
# stella-browser state save "$STATE_FILE"
# echo "Login successful"
# stella-browser snapshot -i
