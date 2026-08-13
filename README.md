# dsh-backup-sync

English | [中文](README.zh.md)

Backup, restore and cross-machine sync for DeepSeek Harness (`dsh`): local snapshots, WebDAV push/pull, auto-backup with retention, and stale archive cleanup.

## Verification status

| Capability | Status | Verified by |
|---|---|---|
| Create / list / prune local snapshots | Verified | Live dsh run (snapshots landed, contents checked) + smoke suite |
| Auto-backup and retention | Verified | Live dsh run (snapshots landed on schedule) |
| WebDAV push / pull / delete | Implemented | Protocol-level mock (incremental skip, meta.json last, residue cleanup, mtime restore, `--force` refresh, path escape, ...) |
| Restore (default and `--all`) | Implemented | Smoke suite; **not yet exercised on a live dsh instance** |
| Real WebDAV servers | Not verified | Not connected to Nextcloud/坚果云 etc.; server quirks (MKCOL/PROPFIND differences) may need adjustment |

## Features

- **Local snapshots**: copy the key parts of `$DSH_HOME` into a point-in-time snapshot (`/backup`)
  - Session logs (`sessions/`, compressed files copied verbatim)
  - Workspace registry data (`storages/`, e.g. `workspace.json`)
  - Configuration layer (`settings.yaml`, `cordis.patch.yml`, per-profile user layers; restored only with `restore --all`)
  - Optional attachments (`attachments/`, large, off by default)
- **Cross-machine sync**: push and pull snapshots over WebDAV (Nextcloud / 坚果云 / Synology / S3 gateways, ...)
  - **Incremental transfers**: push/pull compare the manifest (size + mtime) and skip unchanged files; file mtimes are restored after pull, so a second sync downloads nothing
  - The manifest (`meta.json`) is uploaded **last**, so an interrupted push is never mistaken for a complete snapshot
  - Push prunes remote leftovers of the old manifest; pull removes local leftovers
- **Restore**: by default only session logs and workspace data are restored; `--all` also restores configuration (with an automatic pre-restore safety snapshot)
- **Auto-backup**: scheduled snapshots at a minute interval, pruned by a retention policy

## Quick start

```sh
# source build: pnpm dsh web · npx build: npx --registry=https://registry.npmjs.org -y @deepseek-ai/dsh web --port 0
pnpm dsh web
# in the conversation:
/backup              # create the first snapshot
/backup list         # list snapshots (time, host, file count, size)
/backup prune 5      # keep only the 5 most recent
```

With `autoIntervalMinutes: 30` configured, a snapshot is taken every 30 minutes (stored under `$DSH_HOME/backups/snapshots/`).

## Requirements

- DeepSeek Harness source checkout (this plugin links its `@deepseek-ai/*` packages via pnpm `link:` and is not published to npm)
- pnpm 11+, Node 22+ (Node 24 for the smoke suite)

The default `link:` paths assume the plugin lives at `<harness parent>/dsh-plugin/plugins/backup-sync`; adjust `package.json` after moving the directory.

## Install

### Via the source checkout (development)

```sh
pnpm install
pnpm run build

# install into a profile (run in the harness checkout)
pnpm dsh plugin --profile web add ../path/to/backup-sync
pnpm dsh web
```

### Via npx (verified)

```sh
# the first run downloads @deepseek-ai/dsh (npm package, not the source checkout)
npx --registry=https://registry.npmjs.org -y @deepseek-ai/dsh plugin --profile web add <path-to-this-plugin>
npx --registry=https://registry.npmjs.org -y @deepseek-ai/dsh web --port 0
```

- If npm is configured with a mirror such as npmmirror, **explicitly pass `--registry=https://registry.npmjs.org`**: the mirror serves stale `@deepseek-ai/dsh` metadata (possibly an old version with missing deps), and npm 11's npx lock check rejects non-official registries
- The npx build shares `$DSH_HOME` and profiles with the source build; the plugin's `link:` deps point at the local harness checkout, which must exist and be built (`pnpm run build`)

## Commands

| Command | Description |
|---|---|
| `/backup [name]` | Create a local snapshot (default: timestamp name) |
| `/backup list` | List local and remote snapshots |
| `/backup push <name>` | Push a local snapshot to the remote (incremental; prunes remote leftovers) |
| `/backup pull <name> [--force]` | Sync a snapshot from the remote (incremental; `--force` clears and refetches) |
| `/backup restore <name> [--all]` | Restore from a local snapshot; `--all` also restores configuration (restart required) |
| `/backup prune [keep]` | Prune old local snapshots (default: `autoKeep`) |
| `/backup remote-prune <name>` | Delete a remote snapshot |
| `/backup sweep-archives` | Remove stale archived session entries (see "Restore safety") |

## Configuration (cordis.patch.yml)

```yaml
- insert:
    - id: backup-sync
      name: '@dsh-plugin/backup-sync'
      config:
        backupRoot: ''            # local snapshot root; empty = $DSH_HOME/backups
        includeAttachments: false # back up attachments (large)
        includeCredentials: false # back up .credentials.yaml (contains secrets; off by default)
        autoIntervalMinutes: 0    # auto-backup interval in minutes; 0 = off
        autoKeep: 10              # snapshots to keep; 0 = never prune
        remote:
          baseUrl: ''             # WebDAV root URL
          username: ''
          password: ''            # prefer credential refs, see below
```

### WebDAV credentials

When `remote.password` (and optionally `username`) are left empty, the plugin resolves them from the credential refs `WEBDAV_PASSWORD` / `WEBDAV_USERNAME`:

```sh
# configured in harness (written to $DSH_HOME/.credentials.yaml, mode 0600)
dsh credential set WEBDAV_USERNAME ...
dsh credential set WEBDAV_PASSWORD ...
```

> Do not put plaintext passwords in `cordis.patch.yml` (it is part of the config repo). `.credentials.yaml` is not backed up by default.

Remote layout: `<baseUrl>/dsh-backup/<snapshot-name>/…`.

## Restore safety

- `restore` automatically snapshots the current state first (`…-pre-restore`) so you can always roll back
- By default, running configuration is **not** overwritten; `--all` restores `settings.yaml` and per-profile `cordis.patch.yml`, rolling other plugins' config back to the snapshot moment — restart required
- Prefer running restore while dsh is idle; busy session logs are skipped with a warning
- **Stale archives**: dsh's archive list (sidebar "Archived") stores session ids without validating that the logs still exist — after a restore overwrite or log deletion, entries linger (ghost archives). This plugin sweeps them automatically after `restore`, or on demand via `/backup sweep-archives`; older dsh builds without `workspace.unarchiveSession` report it as unsupported

## Known limitations

- **Snapshots are not strictly atomic**: a session log may be appended to while it is being copied (the copy is a consistent prefix at copy time; the tail may be missing)
- **Restore needs idle dsh**: busy session logs are skipped with a warning (especially on Windows); the automatic pre-restore snapshot lets you validate on a test profile first
- **Real WebDAV compatibility**: behavior is verified against a mock; different servers (Nextcloud / Synology / 坚果云) may handle MKCOL on existing directories and PROPFIND response formats differently — please report issues (errors are user-facing: auth failure / path missing / out of space, ...)
- Running two dsh instances on the same `$DSH_HOME` is unsupported (each prunes by its own view)
- On Windows, avoid reserved names (`CON`, `AUX`, ...) and trailing dots in snapshot names

## Development

The build uses **tsdown** (rolldown-driven), see `tsdown.config.ts`: `fixedExtension: false`, `dts: false`, `clean: false`; dependency externalization follows tsdown defaults (excluded via `package.json` `dependencies`).

```sh
pnpm run build      # tsdown builds lib/index.js (host ESM) + lib/client.js (browser CJS wrapper)
pnpm run watch      # tsdown --watch
pnpm run typecheck  # tsc --noEmit
pnpm run smoke      # core smoke suite (local snapshots + WebDAV mock, no external services)
```

## License

MIT
