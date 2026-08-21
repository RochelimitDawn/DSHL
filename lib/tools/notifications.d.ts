import { type ToolDeps } from './shared.js';
/**
 * linuxdo_get_notifications：读取当前用户的站内通知。
 * 注意这是用户个人数据，仅在用户主动询问时调用。
 */
export declare function buildNotificationsTool(deps: ToolDeps): import("@deepseek-ai/dsh-tools").ToolDefinition;
