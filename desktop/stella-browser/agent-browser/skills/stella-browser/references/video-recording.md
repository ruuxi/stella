# Video Recording

Capture browser automation as video for debugging, documentation, or verification.

**Related**: [commands.md](commands.md) for full command reference, [SKILL.md](../SKILL.md) for quick start.

## Contents

- [Basic Recording](#basic-recording)
- [Recording Commands](#recording-commands)
- [Use Cases](#use-cases)
- [Best Practices](#best-practices)
- [Output Format](#output-format)
- [Limitations](#limitations)

## Basic Recording

```bash
# Start recording
stella-browser record start ./demo.webm

# Perform actions
stella-browser open https://example.com
stella-browser snapshot -i
stella-browser click @e1
stella-browser fill @e2 "test input"

# Stop and save
stella-browser record stop
```

## Recording Commands

```bash
# Start recording to file
stella-browser record start ./output.webm

# Stop current recording
stella-browser record stop

# Restart with new file (stops current + starts new)
stella-browser record restart ./take2.webm
```

## Use Cases

### Debugging Failed Automation

```bash
#!/bin/bash
# Record automation for debugging

stella-browser record start ./debug-$(date +%Y%m%d-%H%M%S).webm

# Run your automation
stella-browser open https://app.example.com
stella-browser snapshot -i
stella-browser click @e1 || {
    echo "Click failed - check recording"
    stella-browser record stop
    exit 1
}

stella-browser record stop
```

### Documentation Generation

```bash
#!/bin/bash
# Record workflow for documentation

stella-browser record start ./docs/how-to-login.webm

stella-browser open https://app.example.com/login
stella-browser wait 1000  # Pause for visibility

stella-browser snapshot -i
stella-browser fill @e1 "demo@example.com"
stella-browser wait 500

stella-browser fill @e2 "password"
stella-browser wait 500

stella-browser click @e3
stella-browser wait --load networkidle
stella-browser wait 1000  # Show result

stella-browser record stop
```

### CI/CD Test Evidence

```bash
#!/bin/bash
# Record E2E test runs for CI artifacts

TEST_NAME="${1:-e2e-test}"
RECORDING_DIR="./test-recordings"
mkdir -p "$RECORDING_DIR"

stella-browser record start "$RECORDING_DIR/$TEST_NAME-$(date +%s).webm"

# Run test
if run_e2e_test; then
    echo "Test passed"
else
    echo "Test failed - recording saved"
fi

stella-browser record stop
```

## Best Practices

### 1. Add Pauses for Clarity

```bash
# Slow down for human viewing
stella-browser click @e1
stella-browser wait 500  # Let viewer see result
```

### 2. Use Descriptive Filenames

```bash
# Include context in filename
stella-browser record start ./recordings/login-flow-2024-01-15.webm
stella-browser record start ./recordings/checkout-test-run-42.webm
```

### 3. Handle Recording in Error Cases

```bash
#!/bin/bash
set -e

cleanup() {
    stella-browser record stop 2>/dev/null || true
    stella-browser close 2>/dev/null || true
}
trap cleanup EXIT

stella-browser record start ./automation.webm
# ... automation steps ...
```

### 4. Combine with Screenshots

```bash
# Record video AND capture key frames
stella-browser record start ./flow.webm

stella-browser open https://example.com
stella-browser screenshot ./screenshots/step1-homepage.png

stella-browser click @e1
stella-browser screenshot ./screenshots/step2-after-click.png

stella-browser record stop
```

## Output Format

- Default format: WebM (VP8/VP9 codec)
- Compatible with all modern browsers and video players
- Compressed but high quality

## Limitations

- Recording adds slight overhead to automation
- Large recordings can consume significant disk space
- Some headless environments may have codec limitations
