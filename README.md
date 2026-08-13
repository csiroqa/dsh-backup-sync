# dsh-backup-sync

DeepSeek Harness（`dsh`）备份/恢复 + 跨机同步插件：本地快照、WebDAV 远端推送/拉取、自动备份与保留策略。

## 验证状态

| 能力 | 状态 | 验证方式 |
|---|---|---|
| 创建/列出/清理本地快照 | 已实测 | 真实 dsh 运行（快照落盘、内容核对）+ 冒烟测试 |
| 自动备份与保留策略 | 已实测 | 真实 dsh 运行（按间隔自动落盘） |
| WebDAV 推送/拉取/删除 | 已实现 | 协议级 mock 验证（push 中途失败、meta 后置、force 清理、路径逃逸等） |
| 恢复（默认与 `--all`） | 已实现 | 冒烟测试覆盖；**未在运行中的 dsh 实例上实测** |
| 真实 WebDAV 服务器 | 未验证 | 未连接 Nextcloud/坚果云等真实服务器，协议细节（MKCOL/PROPFIND 差异）可能需按服务器微调 |

## 功能

- **本地快照**：一键把 `$DSH_HOME` 关键数据复制为时间点快照（`/backup`）
  - 会话日志（`sessions/`，含压缩文件原样复制）
  - 工作区注册数据（`storages/`，如 `workspace.json`）
  - 配置层（`settings.yaml`、`cordis.patch.yml`、各 profile 用户层，仅 `restore --all` 还原）
  - 可选附件（`attachments/`，体积大，默认关闭）
- **跨机同步**：通过 WebDAV（Nextcloud / 坚果云 / 群晖 / S3 网关等）推送与拉取快照
  - push 的清单（`meta.json`）最后上传：中途失败不会被另一台机器当成完整快照
- **恢复**：默认只还原会话日志与工作区数据；`--all` 连配置一起还原（恢复前自动对现状建保险快照）
- **自动备份**：按分钟间隔定时快照，并按保留策略自动清理旧快照

## 快速上手

```sh
# 源码版：pnpm dsh web；npx 版：npx --registry=https://registry.npmjs.org -y @deepseek-ai/dsh web --port 0
pnpm dsh web
# 对话中：
/backup              # 创建第一个快照
/backup list         # 查看快照（时间、主机、文件数、大小）
/backup prune 5      # 只保留最近 5 个
```

配置 `autoIntervalMinutes: 30` 后每 30 分钟自动快照一次（快照存放于 `$DSH_HOME/backups/snapshots/`）。

## 环境要求

- DeepSeek Harness 源码仓库（本插件通过 pnpm `link:` 依赖其 `@deepseek-ai/*` 包，未发布到 npm）
- pnpm 11+、Node 22+（开发构建需 Node 24 以运行冒烟测试）

默认 `link:` 路径按"本插件位于 `<harness 上级目录>/dsh-plugin/plugins/backup-sync`"解析；移动目录后请调整 `package.json` 中的 `link:` 路径。

## 安装

### 通过源码仓库（开发环境）

```sh
pnpm install
pnpm run build

# 装进 profile（在 harness 仓库目录执行）
pnpm dsh plugin --profile web add ../path/to/backup-sync
pnpm dsh web
```

### 通过 npx（已实测）

```sh
# 首次运行需联网下载 @deepseek-ai/dsh（npm 包形式，非源码仓库）
npx --registry=https://registry.npmjs.org -y @deepseek-ai/dsh plugin --profile web add <本插件路径>
npx --registry=https://registry.npmjs.org -y @deepseek-ai/dsh web --port 0
```

- 若本机 npm 配置了 npmmirror 等镜像，**必须显式 `--registry=https://registry.npmjs.org`**：镜像上 `@deepseek-ai/dsh` 数据滞后（可能解析到旧版本且缺依赖），且 npm 11 的 npx 锁校验会拒绝非官方 registry
- npx 版与源码版共享 `$DSH_HOME` 与 profile；插件的 `link:` 依赖指向本地 harness 源码，需保持该路径存在且已 `pnpm run build`

## 命令

| 命令 | 说明 |
|---|---|
| `/backup [快照名]` | 创建本地快照（默认时间戳名） |
| `/backup list` | 列出本地与远端快照 |
| `/backup push <快照名>` | 推送本地快照到远端（覆盖远端同名） |
| `/backup pull <快照名> [--force]` | 从远端拉取快照到本地（不自动恢复） |
| `/backup restore <快照名> [--all]` | 从本地快照恢复；`--all` 连配置一起还原（需重启生效） |
| `/backup prune [保留数]` | 清理旧本地快照（默认按配置 `autoKeep`） |
| `/backup remote-prune <快照名>` | 删除远端快照 |

## 配置（cordis.patch.yml）

```yaml
- insert:
    - id: backup-sync
      name: '@dsh-plugin/backup-sync'
      config:
        backupRoot: ''            # 本地快照目录；空 = $DSH_HOME/backups
        includeAttachments: false # 是否备份附件（体积大）
        includeCredentials: false # 是否备份 .credentials.yaml（含明文密钥，默认关）
        autoIntervalMinutes: 0    # 自动备份间隔（分钟）；0 = 关闭
        autoKeep: 10              # 保留最近快照数；0 = 从不清理
        remote:
          baseUrl: ''             # WebDAV 根地址
          username: ''
          password: ''            # 建议勿写明文，见下
```

### WebDAV 凭据

`remote.password`（及可选 `username`）留空时，插件从凭据引用 `WEBDAV_PASSWORD` / `WEBDAV_USERNAME` 解析：

```sh
# 在 harness 中配置（写入 $DSH_HOME/.credentials.yaml，权限 0600）
dsh credential set WEBDAV_USERNAME ...
dsh credential set WEBDAV_PASSWORD ...
```

> 不要把明文密码写进 `cordis.patch.yml`（该文件随配置入库）。`.credentials.yaml` 不会被默认备份。

远端目录布局：`<baseUrl>/dsh-backup/<快照名>/…`。

## 恢复安全

- `restore` 前自动对现状建保险快照（`…-pre-restore`），可随时回退
- 默认**不**覆盖运行中配置；`--all` 会还原 `settings.yaml` 与各 profile 的 `cordis.patch.yml`，其他插件配置将回退为快照时刻的状态，需重启生效
- 建议在 dsh 空闲时执行恢复；会话日志正被占用时相关文件会跳过并在输出中警告

## 已知限制

- **快照不是严格原子**：会话日志在复制期间可能正被追加（复制到的是某一时刻的一致前缀，尾记录可能缺失）
- **恢复需在 dsh 空闲时执行**：会话日志正被占用时相关文件会跳过并在输出中警告（Windows 上尤为常见）；恢复前会自动留保险快照，可先 `restore` 到测试 profile 验证
- **真实 WebDAV 兼容性**：协议行为已在 mock 服务器上验证；不同服务器（Nextcloud / 群晖 / 坚果云）对 MKCOL 已存在目录、PROPFIND 响应格式的处理可能不同，如遇异常请反馈（错误信息已人化：认证失败/路径不存在/空间不足等）
- 不支持两个 dsh 实例共享同一 `$DSH_HOME`（自动清理会按各自视图互删）
- Windows 上快照名避开保留名（`CON`、`AUX` 等）与尾点

## 开发

```sh
pnpm run build      # esbuild 构建 lib/index.js + lib/client.js
pnpm run watch      # 监听 src/ 自动重编
pnpm run typecheck  # tsc --noEmit
pnpm run smoke      # 35 项核心逻辑冒烟测试（本地快照 + WebDAV mock，零外部服务）
```

## 许可证

MIT
