#!/bin/bash
# Template: Form Automation Workflow
# Purpose: Fill and submit web forms with validation
# Usage: ./form-automation.sh <form-url>
#
# This template demonstrates the snapshot-interact-verify pattern:
# 1. Navigate to form
# 2. Snapshot to get element refs
# 3. Fill fields using refs
# 4. Submit and verify result
#
# Customize: Update the refs (@e1, @e2, etc.) based on your form's snapshot output

set -euo pipefail

FORM_URL="${1:?Usage: $0 <form-url>}"

echo "Form automation: $FORM_URL"

# Step 1: Navigate to form
stella-browser open "$FORM_URL"
stella-browser wait --load networkidle

# Step 2: Snapshot to discover form elements
echo ""
echo "Form structure:"
stella-browser snapshot -i

# Step 3: Fill form fields (customize these refs based on snapshot output)
#
# Common field types:
#   stella-browser fill @e1 "John Doe"           # Text input
#   stella-browser fill @e2 "user@example.com"   # Email input
#   stella-browser fill @e3 "SecureP@ss123"      # Password input
#   stella-browser select @e4 "Option Value"     # Dropdown
#   stella-browser check @e5                     # Checkbox
#   stella-browser click @e6                     # Radio button
#   stella-browser fill @e7 "Multi-line text"   # Textarea
#   stella-browser upload @e8 /path/to/file.pdf # File upload
#
# Uncomment and modify:
# stella-browser fill @e1 "Test User"
# stella-browser fill @e2 "test@example.com"
# stella-browser click @e3  # Submit button

# Step 4: Wait for submission
# stella-browser wait --load networkidle
# stella-browser wait --url "**/success"  # Or wait for redirect

# Step 5: Verify result
echo ""
echo "Result:"
stella-browser get url
stella-browser snapshot -i

# Optional: Capture evidence
stella-browser screenshot /tmp/form-result.png
echo "Screenshot saved: /tmp/form-result.png"

# Cleanup
stella-browser close
echo "Done"
