# dsh-backup-sync

[![CI](https://github.com/csiroqa/dsh-backup-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/csiroqa/dsh-backup-sync/actions/workflows/ci.yml)

DeepSeek Harness（DSH）的**备份/恢复 + 跨机同步**插件：一键把 `$DSH_HOME` 关键数据复制为本地快照（会话日志、工作区数据、配置层），通过 WebDAV 在机器间增量推送/拉取（换机迁移、异地备份），支持定时自动备份与失效归档清理。

English: [README.en.md](README.en.md)

## 功能

### 本地快照

- **一键快照**：`/backup [快照名]` 把 `$DSH_HOME` 的会话日志（`sessions/`）、工作区注册数据（`storages/`，如 `workspace.json`）、配置层（`settings.yaml`、`cordis.patch.yml`、各 profile 用户层）复制为时间点快照；可选附件（`attachments/`，体积大，默认关闭）
- **清单可靠**：快照带 `meta.json` 清单（文件路径/大小/修改时间），`/backup list` 查看时间、主机、文件数与大小，`/backup prune [保留数]` 清理旧快照

### 跨机同步

- **WebDAV 传输**：Nextcloud / 坚果云 / 群晖 / S3 网关等，`/backup push <快照名>` 上传、`/backup pull <快照名>` 下载，远端布局 `<baseUrl>/dsh-backup/<快照名>/`
- **增量传输**：push/pull 按清单对比（大小 + 修改时间），未变化的文件跳过；拉取后恢复文件时间，二次同步零下载
- **中断安全**：清单 `meta.json` 最后上传——推送中断不会被另一台机器当成完整快照；重试天然幂等
- **残留自清理**：推送自动删除远端旧清单残留，拉取自动删除本地多余文件；`/backup remote-prune <快照名>` 删除整个远端快照

### 自动备份

- `autoIntervalMinutes` 定时快照，`autoKeep` 只保留最近 N 份（自动清理）；恢复前自动对现状建 `…-pre-restore` 保险快照

### 失效归档清理

- DSH 归档列表只记会话 id、不校验日志是否存在（幽灵归档）：`restore` 成功后自动清扫，或 `/backup sweep-archives` 手动执行

## 配置

插件行（`cordis.patch.yml` 的 `backup-sync` insert 行）支持以下可选 config：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `backupRoot` | `$DSH_HOME/backups` | 本地快照根目录 |
| `includeAttachments` | `false` | 是否备份附件（体积大） |
| `includeCredentials` | `false` | 是否备份 `.credentials.yaml`（含明文密钥，默认关） |
| `autoIntervalMinutes` | `0` | 自动备份间隔（分钟）；`0` = 关闭 |
| `autoKeep` | `10` | 保留最近快照数；`0` = 从不清理 |
| `remote.baseUrl` | 空 | WebDAV 根地址（如 `https://dav.example.com/remote.php/dav/files/user/dsh-backups`） |
| `remote.username` / `remote.password` | 空 | 留空时从凭据引用 `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` 解析 |

> 不要把明文密码写进 `cordis.patch.yml`。`.credentials.yaml` 不会被默认备份。

## 安装

前置：Node.js >= 22、pnpm。依赖全部取自 npm registry（`peerDependencies` + `devDependencies`，无 `link:` 机器路径），克隆到任意路径即可安装。

```sh
git clone https://github.com/csiroqa/dsh-backup-sync.git
cd dsh-backup-sync
pnpm install
pnpm build

# 安装进 web profile（link: 指向本目录）
dsh plugin --profile web add link:$(pwd)        # POSIX
dsh plugin --profile web add link:E:\path\to\dsh-backup-sync   # Windows
```

重启 `dsh web`，浏览器 **Ctrl+F5** 强刷。

（npx 方式亦可：`npx --registry=https://registry.npmjs.org -y @deepseek-ai/dsh plugin --profile web add <本插件路径>`——需显式官方 registry：镜像数据滞后且 npm 11 的 npx 锁校验会拒绝非官方源。）

## 使用

1. 对话输入 `/backup` 创建第一个快照；`/backup list` 查看（时间 / 主机 / 文件数 / 大小）
2. 配置 `remote.baseUrl` 与凭据后：`/backup push <快照名>` 推送到远端；换机后 `/backup pull <快照名>` + `/backup restore <快照名>` 完整迁移
3. `/backup restore <快照名> [--all]` 恢复：默认只还原会话日志与工作区数据（恢复前自动留保险快照）；`--all` 连配置一起还原（需重启生效）
4. `/backup sweep-archives` 清理失效归档；`/backup prune 5` 只保留最近 5 个

## 开发与测试

```sh
pnpm install          # 依赖取自 npm registry（可移植，无 link: 机器路径）
pnpm run typecheck    # tsc --noEmit 类型检查
pnpm run build        # tsdown 双半区构建（lib/index.js + lib/client.js）
pnpm test             # 冒烟/集成测试别名（= pnpm smoke，40 项：本地快照 + 假 WebDAV 服务端）
```

- **依赖约定**：`@deepseek-ai/*` 共享宿主包在 `peerDependencies`（运行时由 DSH 宿主注入）与 `devDependencies`（本地编译期解析，semver 范围）各声明一份；`tsdown.config.ts` 中 host 半区用 `deps.neverBundle` 显式保持这些包 external，禁止内联进 `lib/index.js`。
- **CI**：GitHub Actions 三平台（Linux/macOS/Windows）跑 `pnpm install --frozen-lockfile` → `typecheck` → `build` → `smoke`。
- **browser 半区边界**：`lib/client.js` 依赖 DSH Web 宿主的 `window.__ModuleLoader__` 运行环境，不可在纯 Node 中直接运行；客户端仅引用平台模块（`react` 等）。

## 兼容性

- **平台**：Windows / macOS / Linux（Node >= 22）—— 构建与冒烟测试经 [GitHub Actions CI](https://github.com/csiroqa/dsh-backup-sync/actions) 验证
- **凭据**：通过 DSH 凭据引用（`WEBDAV_USERNAME` / `WEBDAV_PASSWORD`，存于 `$DSH_HOME/.credentials.yaml`），不落配置库
- 针对 DSH `0.1.0-rc.7`（npm 安装）实测可用；`@deepseek-ai/*` 以 `peerDependencies` 声明，运行时由宿主注入同源包（不携带独立副本）
- 客户端仅依赖平台模块表（react 等），不随 DSH SDK 版本漂移
- 构建产物：`tsdown`（host 半区 `lib/index.js` + browser 半区 `lib/client.js`，标准 `window.__ModuleLoader__.load` 闭包工厂格式）

## 安全声明

- **快照含你的全部会话与工作区数据**：存放于 `$DSH_HOME/backups/snapshots/`，请勿把该目录暴露给不可信方；启用 `includeCredentials` 时还会包含明文密钥
- **恢复会覆盖当前数据**：`restore` 前会自动留保险快照可回退，但建议先在测试 profile 验证；`--all` 会回退其他插件的配置（需重启生效）
- **远端凭据**：WebDAV 用户名/密码建议走凭据引用；若写在 `cordis.patch.yml`，请勿把该文件入库或外发
- 插件自身不做网络监听（纯命令 + 出站 WebDAV 请求）

## 许可与使用声明

**MIT License**（见 [LICENSE](LICENSE)）。

欢迎任何人**使用、修改、引用、或把本项目收录进自己的插件合集**，只需：

- 保留 `LICENSE` 文件与版权声明
- 标明出处（本仓库链接）

## 相关

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- 系列插件：[dsh-schedule](https://github.com/csiroqa/dsh-schedule)（定时任务 + 状态监控）、[dsh-archive-viewer](https://github.com/csiroqa/dsh-archive-viewer)（归档增强：自动归档 / 文件夹 / 经验库 / 收藏便签）
- 插件形态参考 [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)（`dsh.bundle.patch` + `dsh.client` 声明 + 槽位注册 + tsdown 双半区构建）
