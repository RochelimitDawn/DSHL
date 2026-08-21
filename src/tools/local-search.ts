import { defineTool } from '@deepseek-ai/dsh-tools';
import { pruneUndefined, renderAsText, type ToolDeps } from './shared.js';
import type { LocalIndex } from '../core/local-index.js';

/**
 * linuxdo_search_local：本地知识库检索。
 * 查询读过的话题内容，零站内请求、离线可用。
 */
export function buildLocalSearchTool(deps: ToolDeps, localIndex: LocalIndex) {
  return defineTool({
    name: 'linuxdo_search_local',
    description:
      '在本地知识库中检索之前读过的 Linux.do 话题与帖子。' +
      '完全离线、不消耗站点请求预算，适合复查已看过的内容或站内搜索不可用时兜底。' +
      '覆盖范围仅限本会话/本机读取过的楼层；查全站请用 linuxdo_search。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词（中文至少 2 字）' },
      limit: { type: 'integer', description: '返回条数，默认 15，上限 50' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderAsText(value),
    },
    async execute(args) {
      const { query, limit } = args as { query: string; limit?: number };
      const effectiveLimit = Math.min(Math.max(limit ?? 15, 1), 50);
      const hits = localIndex.search(query, { limit: effectiveLimit });
      return pruneUndefined({
        query,
        totalIndexed: localIndex.count(),
        resultCount: hits.length,
        ...(hits.length > 0
          ? { hint: '用 linuxdo_get_topic 可重新读取话题全文' }
          : {}),
        results: hits.map((hit) => ({
          topicId: hit.topicId,
          postId: hit.postId,
          postNumber: hit.postNumber,
          title: hit.title.replace(/\s+/g, '').length > 0 ? hit.title : '(无标题)',
          author: hit.author,
          url: hit.url,
          rank: Math.round(hit.rank * 100) / 100,
        })),
      });
    },
    isConcurrencySafe: () => true,
  });
}
