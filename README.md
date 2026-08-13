# dsh-backup-sync

DeepSeek Harness（`dsh`）**备份/恢复 + 跨机同步**插件：一键把 `$DSH_HOME` 关键数据复制为本地快照，通过 WebDAV 在机器间增量推送/拉取，支持定时自动备份与失效归档清理。

English: [README.en.md](README.en.md)

## 特性

### 本地快照
- `/backup [快照名]` 创建时间点快照，覆盖会话日志（`sessions/`）、工作区注册数据（`storages/`）、配置层（`settings.yaml`、`cordis.patch.yml`、各 profile 用户层，仅 `restore --all` 还原），可选附件（`attachments/`，默认关闭）
- 快照存于 `$DSH_HOME/backups/snapshots/`，`/backup list` 查看，`/backup prune [保留数]` 清理

### 跨机同步
- WebDAV（Nextcloud / 坚果云 / 群晖 / S3 网关等）`push` / `pull`，清单 `meta.json` 最后上传——中断不会产生半成品快照
- **增量传输**：按清单对比（大小 + 修改时间），未变化的文件跳过；拉取后恢复文件时间，二次同步零下载
- 推送自动清理远端旧清单残留；拉取自动清理本地多余文件

### 自动备份
- `autoIntervalMinutes` 定时快照，`autoKeep` 保留最近 N 份自动清理

### 失效归档清理
- dsh 归档列表只记 id、不校验日志存在性（幽灵归档）；`restore` 成功后自动清扫，或 `/backup sweep-archives` 手动执行

## 配置

编辑 `cordis.patch.yml` 的 `backup-sync` insert 段，支持以下可选 config：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `backupRoot` | `$DSH_HOME/backups` | 本地快照根目录 |
| `includeAttachments` | `false` | 是否备份附件（体积大） |
| `includeCredentials` | `false` | 是否备份 `.credentials.yaml`（含明文密钥） |
| `autoIntervalMinutes` | `0` | 自动备份间隔（分钟）；`0` = 关闭 |
| `autoKeep` | `10` | 保留最近快照数；`0` = 从不清理 |
| `remote.baseUrl` | 空 | WebDAV 根地址（如 `https://dav.example.com/remote.php/dav/files/user/dsh-backups`） |
| `remote.username` / `remote.password` | 空 | 留空时从凭据引用 `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` 解析 |

> 不要把明文密码写进 `cordis.patch.yml`。`.credentials.yaml` 不会被默认备份。

## 安装

前置：Node.js >= 22、pnpm；需本地 `deepseek-harness` 源码仓库（插件以 `link:` 依赖其 `@deepseek-ai/*` 包，未发布到 npm）。

```sh
git clone https://github.com/csiroqa/dsh-backup-sync.git
cd dsh-backup-sync
pnpm install
pnpm build

# 装进 web profile（link: 指向本目录）
dsh plugin --profile web add link:$(pwd)      # POSIX
dsh plugin --profile web add link:E:\path\to\dsh-backup-sync   # Windows
```

启动 `dsh web` 后即可在对话中使用 `/backup`；浏览器若加载旧客户端请 **Ctrl+F5** 强刷。

（npx 方式亦可：`npx --registry=https://registry.npmjs.org -y @deepseek-ai/dsh plugin --profile web add <本插件路径>`，注意需显式官方 registry——镜像数据滞后且 npm 11 锁校验会拒绝。）

## 使用

1. `/backup` 创建第一个快照；`/backup list` 查看（时间 / 主机 / 文件数 / 大小）
2. 配置 `remote.baseUrl` 与凭据后：`/backup push <快照名>` 推送到远端；换机后 `/backup pull <快照名>` + `/backup restore <快照名>` 完整迁移
3. `/backup restore <快照名> [--all]` 恢复：默认只还原会话日志与工作区数据（恢复前自动留保险快照）；`--all` 连配置一起还原（需重启生效）
4. `/backup sweep-archives` 清理失效归档；`/backup prune 5` 只保留最近 5 个

## 开发

```sh
pnpm build       # tsdown 构建 lib/index.js（host ESM）+ lib/client.js（browser CJS 包装）
pnpm watch       # tsdown --watch
pnpm typecheck   # tsc --noEmit
pnpm smoke       # 核心冒烟测试（本地快照 + WebDAV mock，零外部服务）
```

## 许可证

MIT
