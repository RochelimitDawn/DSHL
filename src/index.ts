import type { Context } from '@deepseek-ai/cordis';
import { DiscourseClient } from './core/client.js';
import { SessionStore } from './auth/session-store.js';
import { LocalIndex } from './core/local-index.js';
import { TopicCursorStore } from './core/topic-cursor-store.js';
import { resolveConfig, resolveSites, type LinuxdoConfig } from './config.js';
import { buildSearchTool } from './tools/search.js';
import { buildSemanticSearchTool } from './tools/semantic-search.js';
import { buildGetTopicTool, type GetTopicExtras } from './tools/topic.js';
import { buildGetPostTool } from './tools/post.js';
import { buildGetUserTool } from './tools/user.js';
import { buildListCategoriesTool } from './tools/categories.js';
import { buildBrowseTool } from './tools/browse.js';
import { buildNotificationsTool } from './tools/notifications.js';
import { buildStatsTool } from './tools/stats.js';
import { buildLocalSearchTool } from './tools/local-search.js';
import {
  buildAuthStatusTool,
  buildLoginCompleteTool,
  buildLoginTool,
} from './tools/auth-tools.js';
import type { ToolDeps } from './tools/shared.js';

export const name = 'linuxdo';

/** 依赖 tools 注册表与系统提示服务就绪后再挂载。 */
export const inject = ['tools'];

/**
 * 插件入口。
 *
 * @param ctx Cordis 上下文；所有注册经 ctx.effect 包裹，插件卸载时自动回收
 * @param inlineConfig cordis.yml 行内 config（可选）
 */
export function apply(ctx: Context, inlineConfig?: Partial<LinuxdoConfig>): void {
  const config = resolveConfig(inlineConfig, process.env);
  const log = (level: 'info' | 'warn' | 'error', message: string) => {
    ctx.logger[level](`[linuxdo] ${message}`);
  };

  // 站点池：默认站点 + 可选多 Profile
  const sites = resolveSites(config);
  const clients = sites.map((site) => {
    const siteConfig: LinuxdoConfig = {
      ...config,
      baseUrl: site.baseUrl,
      userAgent: site.userAgent ?? config.userAgent,
    };
    const session = new SessionStore(site.sessionFile ?? config.sessionFile);
    return { name: site.name, client: new DiscourseClient(siteConfig, session) };
  });

  const localIndex =
    config.localIndexEnabled && config.localIndexEnabled === true
      ? tryCreateLocalIndex(log)
      : undefined;
  const cursors = new TopicCursorStore();

  const primary = clients[0]!;
  const defaultClient = primary.client;
  const depsFor = (client: DiscourseClient): ToolDeps => ({ client, config, log });
  const multiSite = clients.length > 1;

  // 工具清单：单站点模式全部绑定默认站点
  const tools = [
    buildSearchTool(depsFor(defaultClient)),
    buildSemanticSearchTool(depsFor(defaultClient)),
    buildGetTopicTool(depsFor(defaultClient), { cursors, localIndex }),
    buildGetPostTool(depsFor(defaultClient)),
    buildGetUserTool(depsFor(defaultClient)),
    buildListCategoriesTool(depsFor(defaultClient)),
    buildBrowseTool(depsFor(defaultClient)),
    buildNotificationsTool(depsFor(defaultClient)),
    buildLocalSearchTool(depsFor(defaultClient), localIndex!),
    buildStatsTool(depsFor(defaultClient), { clients, localIndex }),
    buildLoginTool(depsFor(defaultClient), config),
    buildLoginCompleteTool(depsFor(defaultClient), defaultClient, config),
    buildAuthStatusTool(depsFor(defaultClient), defaultClient),
  ];
  void multiSite;

  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool));
    log('info', `已注册 ${tools.length} 个工具（站点：${clients.map((c) => c.name).join(', ')}）`);
    return () => disposers.forEach((dispose) => dispose());
  }, 'linuxdo.register-tools');

  // 系统提示注入：Agent 首次接触即可正确使用工具，减少试错
  ctx.effect(() => {
    const disposer = ctx.systemPrompt.section({
      name: 'linuxdo:guide',
      order: 150,
      text: LINUXDO_TOOL_GUIDE,
    });
    return disposer;
  }, 'linuxdo.system-prompt-guide');
}

function tryCreateLocalIndex(
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
): LocalIndex | undefined {
  try {
    const index = new LocalIndex();
    log('info', `本地知识库已启用（${index.count()} 条）`);
    return index;
  } catch (err) {
    log('warn', `本地知识库初始化失败，已停用：${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

const LINUXDO_TOOL_GUIDE = `## Linux.do 检索工具使用指南

- 模糊意图/自然语言描述用 linuxdo_semantic_search；精确关键词、@用户、category: 过滤用 linuxdo_search；浏览热点/最新动态用 linuxdo_browse。
- 读话题时若返回 nextFromPostNumber，说明有后续楼层，需要继续时用它再次调用 linuxdo_get_topic。
- 跟踪看过的帖子有无更新：mode="incremental"，无新内容时返回 noNewPosts=true，几乎零成本。
- linuxdo_search_local 查询本机已读过的内容，离线可用且不占请求预算；站内限流或离线时优先用它。
- 遇到 AUTH_REQUIRED 错误：调用 linuxdo_login，把返回的 authorizeUrl 展示给用户并在浏览器打开完成授权；手动模式下用户会给你一个回调 URL，用 linuxdo_login_complete 提交。
- CF_CHALLENGE 错误表示被 Cloudflare 拦截：稍后重试，或建议用户配置 LINUXDO_CURL_IMPERSONATE 指向 curl-impersonate 二进制。`;

export default apply;
