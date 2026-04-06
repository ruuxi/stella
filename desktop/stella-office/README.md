# stella-office

Repo-local CLI wrapper, vendored OfficeCli source, and binary layout for Stella's bundled Office document command.

## Layout

- `bin/stella-office.js` — fixed wrapper path used by Stella runtime
- `bin/stella-office-<platform>-<arch>` — native binary for the current or shipped platform
- `scripts/` — maintainer helpers for syncing version and managing the native binary
- `vendor/officecli/` — vendored upstream OfficeCli repository used for local version/build provenance

## Maintainer Commands

```bash
npm run version:sync
npm run copy:native
npm run build:native
npm run download:native
```

- `version:sync` reads the vendored OfficeCli project version and updates `package.json`
- `copy:native` copies a locally built vendored OfficeCli binary into the fixed `bin/` naming convention
- `build:native` runs the vendored OfficeCli build script for the current platform, then copies the binary
- `download:native` downloads the pinned current-platform release artifact into `bin/`
