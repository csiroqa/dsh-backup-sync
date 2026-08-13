/**
 * 备份/恢复 + 跨机同步插件 —— browser 半区（骨架）
 *
 * host 半区已提供完整 /backup 命令组（创建/推送/拉取/恢复/清理），
 * 命令结果经 command/done 渲染为会话内 flow 节点，无需额外 UI。
 *
 * 后续可在此实现：
 *  - 设置页：通过 ctx.settingsScope.bind 注册 backup-sync 命名空间表单
 *    （backupRoot / includeAttachments / autoIntervalMinutes / autoKeep / remote），
 *    与 host 半区 ctx.settings.register 配对。
 *  - 状态反馈：订阅 command/done 事件，自动备份完成后经
 *    conversation.input.for(actx).notify('info', ...) 页面内提示。
 *  - 会话头部菜单：把"备份当前工作区"注入 conversation.session.header.actions 槽。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

export const name = 'backup-sync-client'

export function apply(ctx: ClientContext): void {
  void ctx
}
