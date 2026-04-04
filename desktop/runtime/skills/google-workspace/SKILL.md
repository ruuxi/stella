---
id: google-workspace
name: Google Workspace
description: Behavioral guide for Gmail, Google Calendar, Google Drive, and Google Docs via Stella's Google Workspace integration tools. Activate before working with Google services.
agentTypes:
  - general
tags:
  - google
  - gmail
  - calendar
  - drive
  - docs
version: 1
---

# Google Workspace Guide

Use Stella's Google Workspace integration tools (loaded via LoadTools) to act on the user's connected Google account.

## Available Tool Groups

- **Gmail**: `gmail.search`, `gmail.get`, `gmail.downloadAttachment`, `gmail.modify`, `gmail.send`, `gmail.createDraft`, `gmail.sendDraft`, `gmail.listLabels`, `gmail.createLabel`
- **Calendar**: `calendar.list`, `calendar.createEvent`, `calendar.listEvents`, `calendar.getEvent`, `calendar.findFreeTime`, `calendar.updateEvent`, `calendar.respondToEvent`
- **Drive**: `drive.search`, `drive.findFolder`, `drive.createFolder`, `drive.downloadFile`, `drive.renameFile`
- **Docs**: `docs.create`, `docs.getSuggestions`, `docs.getComments`, `docs.writeText`, `docs.getText`, `docs.replaceText`, `docs.formatText`
- **Auth**: `auth.clear`, `auth.refreshToken`
- **Time**: `time.getCurrentDate`, `time.getCurrentTime`, `time.getTimeZone`
- **People**: `people.getMe`

## Behavior

- Prefer reading and listing before changing or sending anything.
- For email: search and read before sending or modifying.
- For calendar: list or get events before creating or updating when context is unclear.
- For Drive: search before downloading or renaming.
- If authentication is required, follow tool responses; the user may need to complete sign-in in their browser once.

## Safety

- Do not exfiltrate or summarize private content beyond what the task requires.
- Treat email and document contents as sensitive.

## Output

- Return concise summaries of what you did and the key results (IDs, times, links) when useful.
- If a tool reports the integration is unavailable, say so plainly and suggest checking that the integration is installed.
