# Authentication Patterns

Login flows, session persistence, OAuth, 2FA, and authenticated browsing.

**Related**: [session-management.md](session-management.md) for state persistence details, [SKILL.md](../SKILL.md) for quick start.

## Contents

- [Basic Login Flow](#basic-login-flow)
- [Saving Authentication State](#saving-authentication-state)
- [Restoring Authentication](#restoring-authentication)
- [OAuth / SSO Flows](#oauth--sso-flows)
- [Two-Factor Authentication](#two-factor-authentication)
- [HTTP Basic Auth](#http-basic-auth)
- [Cookie-Based Auth](#cookie-based-auth)
- [Token Refresh Handling](#token-refresh-handling)
- [Security Best Practices](#security-best-practices)

## Basic Login Flow

```bash
# Navigate to login page
stella-browser open https://app.example.com/login
stella-browser wait --load networkidle

# Get form elements
stella-browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Sign In"

# Fill credentials
stella-browser fill @e1 "user@example.com"
stella-browser fill @e2 "password123"

# Submit
stella-browser click @e3
stella-browser wait --load networkidle

# Verify login succeeded
stella-browser get url  # Should be dashboard, not login
```

## Saving Authentication State

After logging in, save state for reuse:

```bash
# Login first (see above)
stella-browser open https://app.example.com/login
stella-browser snapshot -i
stella-browser fill @e1 "user@example.com"
stella-browser fill @e2 "password123"
stella-browser click @e3
stella-browser wait --url "**/dashboard"

# Save authenticated state
stella-browser state save ./auth-state.json
```

## Restoring Authentication

Skip login by loading saved state:

```bash
# Load saved auth state
stella-browser state load ./auth-state.json

# Navigate directly to protected page
stella-browser open https://app.example.com/dashboard

# Verify authenticated
stella-browser snapshot -i
```

## OAuth / SSO Flows

For OAuth redirects:

```bash
# Start OAuth flow
stella-browser open https://app.example.com/auth/google

# Handle redirects automatically
stella-browser wait --url "**/accounts.google.com**"
stella-browser snapshot -i

# Fill Google credentials
stella-browser fill @e1 "user@gmail.com"
stella-browser click @e2  # Next button
stella-browser wait 2000
stella-browser snapshot -i
stella-browser fill @e3 "password"
stella-browser click @e4  # Sign in

# Wait for redirect back
stella-browser wait --url "**/app.example.com**"
stella-browser state save ./oauth-state.json
```

## Two-Factor Authentication

Handle 2FA with manual intervention:

```bash
# Login with credentials
stella-browser open https://app.example.com/login --headed  # Show browser
stella-browser snapshot -i
stella-browser fill @e1 "user@example.com"
stella-browser fill @e2 "password123"
stella-browser click @e3

# Wait for user to complete 2FA manually
echo "Complete 2FA in the browser window..."
stella-browser wait --url "**/dashboard" --timeout 120000

# Save state after 2FA
stella-browser state save ./2fa-state.json
```

## HTTP Basic Auth

For sites using HTTP Basic Authentication:

```bash
# Set credentials before navigation
stella-browser set credentials username password

# Navigate to protected resource
stella-browser open https://protected.example.com/api
```

## Cookie-Based Auth

Manually set authentication cookies:

```bash
# Set auth cookie
stella-browser cookies set session_token "abc123xyz"

# Navigate to protected page
stella-browser open https://app.example.com/dashboard
```

## Token Refresh Handling

For sessions with expiring tokens:

```bash
#!/bin/bash
# Wrapper that handles token refresh

STATE_FILE="./auth-state.json"

# Try loading existing state
if [[ -f "$STATE_FILE" ]]; then
    stella-browser state load "$STATE_FILE"
    stella-browser open https://app.example.com/dashboard

    # Check if session is still valid
    URL=$(stella-browser get url)
    if [[ "$URL" == *"/login"* ]]; then
        echo "Session expired, re-authenticating..."
        # Perform fresh login
        stella-browser snapshot -i
        stella-browser fill @e1 "$USERNAME"
        stella-browser fill @e2 "$PASSWORD"
        stella-browser click @e3
        stella-browser wait --url "**/dashboard"
        stella-browser state save "$STATE_FILE"
    fi
else
    # First-time login
    stella-browser open https://app.example.com/login
    # ... login flow ...
fi
```

## Security Best Practices

1. **Never commit state files** - They contain session tokens
   ```bash
   echo "*.auth-state.json" >> .gitignore
   ```

2. **Use environment variables for credentials**
   ```bash
   stella-browser fill @e1 "$APP_USERNAME"
   stella-browser fill @e2 "$APP_PASSWORD"
   ```

3. **Clean up after automation**
   ```bash
   stella-browser cookies clear
   rm -f ./auth-state.json
   ```

4. **Use short-lived sessions for CI/CD**
   ```bash
   # Don't persist state in CI
   stella-browser open https://app.example.com/login
   # ... login and perform actions ...
   stella-browser close  # Session ends, nothing persisted
   ```
