import { defineTool } from '@deepseek-ai/dsh-tools';
import { pruneUndefined, renderAsText, type ToolDeps } from './shared.js';
import { relativeTime } from '../core/time.js';

interface NotificationItem {
  id?: number;
  notification_type?: number;
  read?: boolean;
  created_at?: string;
  data?: {
    display_username?: string;
    topic_title?: string;
    original_username?: string;
    message?: string;
  };
}

/** Discourse notification_type 数字码 → 可读名称（常用子集）。 */
const NOTIFICATION_TYPES: Record<number, string> = {
  1: '回复了你参与的话题',
  2: '在帖子中提到了你',
  3: '引用了你的帖子',
  4: '赞了你的帖子',
  5: '赞了你的回复',
  6: '给你发来了私信',
  7: '邀请你参与话题',
  8: '发来了消息',
  9: '链接了你的帖子',
  11: '向你发出了邀请',
  12: '编辑了你的帖子',
  13: '授予你徽章',
  15: '在群组消息中提到了你',
  16: '在帖子中 @ 了你的群组',
};

/**
 * linuxdo_get_notifications：读取当前用户的站内通知。
 * 注意这是用户个人数据，仅在用户主动询问时调用。
 */
export function buildNotificationsTool(deps: ToolDeps) {
  return defineTool({
    name: 'linuxdo_get_notifications',
    description:
      '读取当前登录用户在 Linux.do 的站内通知（被回复、被 @、被点赞、私信等）。' +
      '这是用户个人数据，应在用户主动询问"我的通知/我错过了什么"时调用。' +
      '需要先完成登录（linuxdo_login）。',
    parameters: {
      limit: { type: 'integer', description: '返回条数，默认 15，上限 30' },
      unreadOnly: { type: 'boolean', description: '只看未读，默认 false' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderAsText(value),
    },
    async execute(args, exec) {
      const { limit, unreadOnly } = args as { limit?: number; unreadOnly?: boolean };
      const effectiveLimit = Math.min(Math.max(limit ?? 15, 1), 30);
      const data = await deps.client.getJson<{ notifications?: NotificationItem[] }>(
        '/notifications.json',
        { cacheTtlMs: 0, signal: exec.signal },
      );
      const all = data.notifications ?? [];
      const filtered = unreadOnly ? all.filter((n) => n.read !== true) : all;
      const notifications = filtered.slice(0, effectiveLimit).map((item) => ({
        id: item.id,
        type: NOTIFICATION_TYPES[item.notification_type ?? -1] ?? `未知类型(${item.notification_type})`,
        actor: item.data?.display_username ?? item.data?.original_username,
        topicTitle: item.data?.topic_title,
        message: item.data?.message,
        read: item.read !== false ? true : false,
        timeLabel: relativeTime(item.created_at),
      }));
      const unreadCount = all.filter((n) => n.read !== true).length;
      return pruneUndefined({
        total: all.length,
        unreadCount,
        showing: notifications.length,
        notifications,
      });
    },
  });
}
