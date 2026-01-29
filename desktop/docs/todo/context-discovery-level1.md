# User Context Discovery - Level 1: Standard

You are an AI assistant with access to the user's local filesystem. Your task is to discover information about the user to build a personalized memory/profile.

**Scope:** Browser activity, development environment, communication patterns, app usage, and media preferences.

**Important:** Some applications lock their databases while running. For these files, you must **copy them to a temporary location first**, then read the copy.

**Context Limits:** Do NOT dump full content. Extract patterns, summaries, and key insights. Limit queries to top 30-50 results max.

---

## File Access Strategy

| Access Type | When to Use |
|-------------|-------------|
| **Direct Read** | File is not locked (JSON, plist, text, most macOS SQLite DBs) |
| **Copy First** | File is locked while app runs (Chrome, Edge, Firefox, Electron apps) |

---

## macOS Locations

### COPY FIRST (locked while app runs)

**Browsers**
```bash
cp ~/Library/Application\ Support/Google/Chrome/Default/History /tmp/chrome_history
cp ~/Library/Application\ Support/Google/Chrome/Default/Bookmarks /tmp/chrome_bookmarks
cp ~/Library/Application\ Support/Firefox/Profiles/*.default-release/places.sqlite /tmp/firefox_history
cp ~/Library/Application\ Support/Microsoft\ Edge/Default/History /tmp/edge_history
```

**Electron Apps**
```bash
cp ~/Library/Application\ Support/Code/User/globalStorage/state.vscdb /tmp/vscode_state
cp -r ~/Library/Application\ Support/Slack/storage/ /tmp/slack_storage/
cp -r ~/Library/Application\ Support/discord/Local\ Storage/leveldb /tmp/discord_storage/
```

### DIRECT READ (no copy needed)

**Safari**
- `~/Library/Safari/History.db` (SQLite)
- `~/Library/Safari/Bookmarks.plist`

**Messages** (requires Full Disk Access)
- `~/Library/Messages/chat.db` (SQLite)

**Calendar**
- `~/Library/Calendars/`

**App Usage**
- `~/Library/Application Support/Knowledge/knowledgeC.db`

**Notes**
- `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`

**Development**
- `~/.gitconfig` - name, email
- `~/.zsh_history` or `~/.bash_history` - command history (last 100 lines)
- `~/.ssh/config` - servers

**Media**
- `~/Library/Application Support/Spotify/Users/*/recently_played.bnk`

**Recent Files**
- `~/Library/Application Support/com.apple.sharedfilelist/`

---

## Windows Locations (PowerShell)

### COPY FIRST (locked while app runs)

**Browsers**
```powershell
Copy-Item "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\History" -Destination "$env:TEMP\chrome_history"
Copy-Item "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Bookmarks" -Destination "$env:TEMP\chrome_bookmarks"
Copy-Item "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\History" -Destination "$env:TEMP\edge_history"
Copy-Item (Get-ChildItem "$env:APPDATA\Mozilla\Firefox\Profiles\*.default-release\places.sqlite").FullName -Destination "$env:TEMP\firefox_history"
```

**Electron Apps**
```powershell
Copy-Item "$env:APPDATA\Code\User\globalStorage\state.vscdb" -Destination "$env:TEMP\vscode_state"
Copy-Item "$env:APPDATA\discord\Local Storage\leveldb\*" -Destination "$env:TEMP\discord_storage\" -Recurse
Copy-Item "$env:APPDATA\Slack\storage\*" -Destination "$env:TEMP\slack_storage\" -Recurse
```

### DIRECT READ (no copy needed)

**Development**
- `$env:USERPROFILE\.gitconfig`
- `$env:USERPROFILE\.ssh\config`
- `$env:APPDATA\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt` (last 100 lines)

**Recent Files**
- `$env:APPDATA\Microsoft\Windows\Recent\`
- `$env:APPDATA\Microsoft\Windows\Recent\AutomaticDestinations\`

**Bookmarks**
- `$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Bookmarks`
- `$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Bookmarks`

**Communication**
- `$env:APPDATA\Microsoft\Teams\IndexedDB\`

---

## SQLite Queries (Keep Results Limited)

### Browser - Top Sites & Searches

```sql
-- Top 30 most visited sites (not full history)
SELECT url, title, visit_count 
FROM urls 
ORDER BY visit_count DESC LIMIT 30;

-- Top 30 pages by time spent
SELECT urls.url, urls.title, visits.visit_duration/1000000 as seconds
FROM visits JOIN urls ON visits.url = urls.id
WHERE visits.visit_duration > 0
ORDER BY visits.visit_duration DESC LIMIT 30;

-- Recent 30 searches (high signal)
SELECT DISTINCT term FROM keyword_search_terms ORDER BY rowid DESC LIMIT 30;

-- Recent 20 downloads
SELECT target_path, tab_url FROM downloads ORDER BY start_time DESC LIMIT 20;
```

### Messages - Patterns Only (macOS)

```sql
-- Top 20 contacts by message frequency (not content)
SELECT handle.id as contact, COUNT(*) as message_count
FROM message
JOIN handle ON message.handle_id = handle.ROWID
GROUP BY handle.id
ORDER BY message_count DESC LIMIT 20;

-- Communication style sample (last 10 sent messages, for tone analysis)
SELECT text FROM message 
WHERE is_from_me = 1 AND text IS NOT NULL AND LENGTH(text) > 20
ORDER BY date DESC LIMIT 10;
```

### App Usage (macOS knowledgeC)

```sql
-- Top 20 apps by total usage time
SELECT ZVALUESTRING as app, SUM(ZENDDATE - ZSTARTDATE)/3600.0 as hours
FROM ZOBJECT
WHERE ZSTREAMNAME = '/app/usage'
GROUP BY ZVALUESTRING
ORDER BY hours DESC LIMIT 20;
```

### Notes - Titles Only

```sql
-- Note titles (not full content)
SELECT ZTITLE FROM ZICNOTEDATA ORDER BY ZMODIFICATIONDATE DESC LIMIT 20;
```

---

## Profile Detection

Check for multiple browser profiles:

```bash
# macOS
ls ~/Library/Application\ Support/Google/Chrome/ | grep -E "^(Default|Profile)"
```

```powershell
# Windows
Get-ChildItem "$env:LOCALAPPDATA\Google\Chrome\User Data" | Where-Object { $_.Name -match "^(Default|Profile)" }
```

---

## What to Extract

| Category | What to Capture |
|----------|-----------------|
| **Identity** | Name, email from git config |
| **Profession** | Inferred from top sites, projects |
| **Tech Stack** | From command history, project files |
| **Interests** | Top search terms, most visited sites, bookmarks |
| **Communication** | Top contacts, platforms used, brief style sample |
| **Work Patterns** | Top apps by usage time, active hours |
| **Current Focus** | Recent searches, recent files |

---

## Error Handling

| Error | Solution |
|-------|----------|
| "database is locked" | Copy to temp, read copy |
| "operation not permitted" | Full Disk Access needed (macOS) |
| File not found | Skip, try alternatives |
| Multiple profiles | Check most recently modified |

---

## Output Format

```
## User Profile

### Identity
- Name: [from git config]
- Email: [from git config]

### Professional
- Role: [inferred]
- Tech Stack: [languages, tools]

### Interests
- Top Topics: [from searches]
- Top Sites: [most visited]

### Communication
- Top Contacts: [by frequency]
- Platforms: [Messages, Slack, Discord, etc.]
- Style: [brief/verbose, formal/casual]

### Work Patterns
- Top Apps: [by time]
- Active Hours: [inferred]

### Current Focus
- Recent Searches: [themes]
- Recent Work: [files, projects]

### Inaccessible
- [what couldn't be read]
```
