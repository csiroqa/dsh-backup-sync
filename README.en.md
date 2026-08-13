# dsh-backup-sync

Backup, restore and cross-machine sync plugin for DeepSeek Harness (`dsh`): copy the key parts of `$DSH_HOME` into point-in-time local snapshots, push/pull them incrementally between machines over WebDAV, with scheduled auto-backup and stale archive cleanup.

中文: [README.md](README.md)

## Features

### Local snapshots
- `/backup [name]` creates a point-in-time snapshot covering session logs (`sessions/`), workspace registry data (`storages/`), and the configuration layer (`settings.yaml`, `cordis.patch.yml`, per-profile user layers; restored only with `restore --all`); optional attachments (`attachments/`, off by default)
- Snapshots live under `$DSH_HOME/backups/snapshots/`; inspect with `/backup list`, prune with `/backup prune [keep]`

### Cross-machine sync
- WebDAV (Nextcloud / 坚果云 / Synology / S3 gateways, ...) `push` / `pull`; the manifest `meta.json` is uploaded **last**, so an interrupted push is never mistaken for a complete snapshot
- **Incremental transfers**: files are compared by size + mtime from the manifest; unchanged files are skipped, and mtimes are restored after pull, so a second sync downloads nothing
- Push prunes remote leftovers of the old manifest; pull removes local leftovers

### Auto-backup
- `autoIntervalMinutes` schedules snapshots; `autoKeep` retains the most recent N and prunes the rest

### Stale archive cleanup
- The dsh archive list stores ids without validating that the logs still exist (ghost archives); `restore` sweeps automatically, or run `/backup sweep-archives` manually

## Configuration

Edit the `backup-sync` insert block of `cordis.patch.yml`; all config keys are optional:

| Key | Default | Description |
| --- | --- | --- |
| `backupRoot` | `$DSH_HOME/backups` | Local snapshot root |
| `includeAttachments` | `false` | Back up attachments (large) |
| `includeCredentials` | `false` | Back up `.credentials.yaml` (contains secrets) |
| `autoIntervalMinutes` | `0` | Auto-backup interval in minutes; `0` = off |
| `autoKeep` | `10` | Snapshots to keep; `0` = never prune |
| `remote.baseUrl` | empty | WebDAV root URL (e.g. `https://dav.example.com/remote.php/dav/files/user/dsh-backups`) |
| `remote.username` / `remote.password` | empty | When empty, resolved from credential refs `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` |

> Do not put plaintext passwords in `cordis.patch.yml`. `.credentials.yaml` is not backed up by default.

## Install

Prerequisites: Node.js >= 22, pnpm; a local `deepseek-harness` source checkout (this plugin links its `@deepseek-ai/*` packages via `link:` and is not published to npm).

```sh
git clone https://github.com/csiroqa/dsh-backup-sync.git
cd dsh-backup-sync
pnpm install
pnpm build

# install into the web profile (link: points at this directory)
dsh plugin --profile web add link:$(pwd)      # POSIX
dsh plugin --profile web add link:E:\path\to\dsh-backup-sync   # Windows
```

Run `dsh web` and use `/backup` in the conversation; press **Ctrl+F5** if the browser still serves the old client.

(A npx route also works: `npx --registry=https://registry.npmjs.org -y @deepseek-ai/dsh plugin --profile web add <path-to-this-plugin>` — the official registry must be explicit, since mirrors serve stale metadata and npm 11's npx lock check rejects non-official registries.)

## Usage

1. `/backup` creates the first snapshot; `/backup list` shows time / host / file count / size
2. After configuring `remote.baseUrl` and credentials: `/backup push <name>` uploads to the remote; on another machine `/backup pull <name>` + `/backup restore <name>` migrates everything
3. `/backup restore <name> [--all]` restores: by default only session logs and workspace data (with an automatic pre-restore safety snapshot); `--all` also restores configuration (restart required)
4. `/backup sweep-archives` removes stale archives; `/backup prune 5` keeps only the 5 most recent

## Development

```sh
pnpm build       # tsdown builds lib/index.js (host ESM) + lib/client.js (browser CJS wrapper)
pnpm watch       # tsdown --watch
pnpm typecheck   # tsc --noEmit
pnpm smoke       # core smoke suite (local snapshots + WebDAV mock, no external services)
```

## License

MIT
