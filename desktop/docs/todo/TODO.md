# TODO

## Git Bash Setup for Windows

Currently, the app uses Git Bash (`C:\Program Files\Git\bin\bash.exe`) as the default shell on Windows for AI agent compatibility. However, this assumes Git for Windows is installed.

### Completed

- [x] Changed default shell from PowerShell to Git Bash on Windows (`electron/local-host/tools.ts`)
- [x] Added platform detection to user messages (frontend sends `platform` in payload)
- [x] Added platform-specific guidance in system prompt (`backend/convex/http.ts`)
  - Windows: Uses `start` command instead of `open -a`, Git Bash syntax
  - macOS: Uses `open -a` command, bash/zsh syntax  
  - Linux: Uses `xdg-open` command, bash syntax

### Remaining Tasks

- [ ] Add startup check to detect if Git Bash is available on Windows
- [ ] If Git is not installed, show a user-friendly prompt with:
  - Explanation of why Git Bash is needed (better AI agent performance)
  - Link to download Git for Windows: https://git-scm.com/download/win
- [ ] Consider auto-install option (requires admin privileges, may not be suitable for all environments)
- [ ] Add fallback to PowerShell with a warning if user declines Git installation
