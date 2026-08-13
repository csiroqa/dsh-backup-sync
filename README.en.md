# dsh-backup-sync

[![CI](https://github.com/csiroqa/dsh-backup-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/csiroqa/dsh-backup-sync/actions/workflows/ci.yml)

A **backup / restore + cross-machine sync** plugin for DeepSeek Harness (DSH): copy the key parts of `$DSH_HOME` into point-in-time local snapshots (session logs, workspace data, configuration), push/pull them incrementally between machines over WebDAV (machine migration, offsite backup), with scheduled auto-backup and stale archive cleanup.

中文: [README.md](README.md)

## Features

### Local snapshots

- **One-shot snapshot**: `/backup [name]` copies session logs (`sessions/`), workspace registry data (`storages/`, e.g. `workspace.json`) and the configuration layer (`settings.yaml`, `cordis.patch.yml`, per-profile user layers) into a point-in-time snapshot; optional attachments (`attachments/`, large, off by default)
- **Reliable manifest**: every snapshot carries a `meta.json` manifest (path / size / mtime); `/backup list` shows time, host, file count and size, `/backup prune [keep]` removes old snapshots

### Cross-machine sync

- **WebDAV transport**: Nextcloud / 坚果云 / Synology / S3 gateways, ... — `/backup push <name>` uploads, `/backup pull <name>` downloads; remote layout `<baseUrl>/dsh-backup/<name>/`
- **Incremental transfers**: push/pull compare the manifest (size + mtime) and skip unchanged files; mtimes are restored after pull, so a second sync downloads nothing
- **Interrupt-safe**: the manifest `meta.json` is uploaded **last** — an interrupted push is never mistaken for a complete snapshot; retries are idempotent
- **Self-cleaning**: push prunes remote leftovers of the old manifest, pull removes local leftovers; `/backup remote-prune <name>` deletes a whole remote snapshot

### Auto-backup

- `autoIntervalMinutes` schedules snapshots; `autoKeep` retains only the most recent N; every `restore` first takes a `…-pre-restore` safety snapshot of the current state

### Stale archive cleanup

- The DSH archive list stores ids without validating that the logs still exist (ghost archives): `restore` sweeps automatically, or run `/backup sweep-archives` manually

## Configuration

Optional config on the plugin row (`cordis.patch.yml`, the `backup-sync` insert block):

| Key | Default | Description |
| --- | --- | --- |
| `backupRoot` | `$DSH_HOME/backups` | Local snapshot root |
| `includeAttachments` | `false` | Back up attachments (large) |
| `includeCredentials` | `false` | Back up `.credentials.yaml` (contains secrets, off by default) |
| `autoIntervalMinutes` | `0` | Auto-backup interval in minutes; `0` = off |
| `autoKeep` | `10` | Snapshots to keep; `0` = never prune |
| `remote.baseUrl` | empty | WebDAV root URL (e.g. `https://dav.example.com/remote.php/dav/files/user/dsh-backups`) |
| `remote.username` / `remote.password` | empty | When empty, resolved from credential refs `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` |

> Do not put plaintext passwords in `cordis.patch.yml`. `.credentials.yaml` is not backed up by default.

## Install

Requirements: Node.js >= 22, pnpm, a local checkout of `deepseek-harness` (dependencies use `link:` to its `@deepseek-ai/*` packages; not published to npm).

```sh
git clone https://github.com/csiroqa/dsh-backup-sync.git
cd dsh-backup-sync
pnpm install
pnpm build

# install into web profile (link: this directory)
dsh plugin --profile web add link:$(pwd)        # POSIX
dsh plugin --profile web add link:E:\path\to\dsh-backup-sync   # Windows
```

Restart `dsh web` and hard-refresh the browser (**Ctrl+F5**).

(A npx route also works: `npx --registry=https://registry.npmjs.org -y @deepseek-ai/dsh plugin --profile web add <path-to-this-plugin>` — the official registry must be explicit, since mirrors serve stale metadata and npm 11's npx lock check rejects non-official sources.)

## Usage

1. Run `/backup` in the conversation to create the first snapshot; `/backup list` shows time / host / file count / size
2. After configuring `remote.baseUrl` and credentials: `/backup push <name>` uploads to the remote; on another machine `/backup pull <name>` + `/backup restore <name>` migrates everything
3. `/backup restore <name> [--all]` restores: by default only session logs and workspace data (with an automatic pre-restore safety snapshot); `--all` also restores configuration (restart required)
4. `/backup sweep-archives` removes stale archives; `/backup prune 5` keeps only the 5 most recent

## Compatibility

- **Platforms**: Windows / macOS / Linux (Node >= 22) — builds and smoke tests are verified via [GitHub Actions CI](https://github.com/csiroqa/dsh-backup-sync/actions)
- **Credentials**: resolved through DSH credential refs (`WEBDAV_USERNAME` / `WEBDAV_PASSWORD`, stored in `$DSH_HOME/.credentials.yaml`), never in the config repo
- Verified against DSH `0.1.0-rc.6` (source checkout and npm/npx install)
- The client half depends only on platform modules (react, etc.)
- Build: `tsdown` (host `lib/index.js` + browser `lib/client.js`, standard `window.__ModuleLoader__.load` closure-factory format)

## Security notes

- **Snapshots contain all your sessions and workspace data**: they live under `$DSH_HOME/backups/snapshots/` — do not expose that directory to untrusted parties; enabling `includeCredentials` also embeds plaintext secrets
- **Restore overwrites current data**: a `…-pre-restore` safety snapshot is taken automatically, but validate on a test profile first; `--all` rolls other plugins' config back (restart required)
- **Remote credentials**: prefer credential refs for WebDAV; if written into `cordis.patch.yml`, keep that file out of any public repo
- The plugin never listens on the network (commands plus outbound WebDAV requests only)

## License

**MIT License** (see [LICENSE](LICENSE)). Use, modify, reference, or include it in your own plugin collections — just keep the license notice and credit this repository.

## Related

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- Companion plugins: [dsh-schedule](https://github.com/csiroqa/dsh-schedule) (scheduled tasks + status monitoring), [dsh-archive-viewer](https://github.com/csiroqa/dsh-archive-viewer) (archive enhancements: auto-archive / folders / knowledge library / bookmarks & notes)
- Plugin form reference: [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) (`dsh.bundle.patch` + `dsh.client` declaration + slot registration + tsdown dual-half build)
