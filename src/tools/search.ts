import { defineTool } from '@deepseek-ai/dsh-tools';
import { compactSearchResult, pruneUndefined, renderAsText, type ToolDeps } from './shared.js';
import { TtlCache } from '../core/cache.js';
import { ApiError, AuthRequiredError, ChallengeError } from '../core/errors.js';

/**
 * linuxdo_search：Discourse 标准全文搜索（BM25）。
 * 支持 Discourse 搜索语法（如 @user、category:x、order:likes）直接透传。
 */

/** 分类名缓存：一次拉取全量分类表，避免每条结果重复查询。 */
let categoryCache: TtlCache<Map<number, string>> | undefined;

export async function loadCategoryNames(
  deps: ToolDeps,
  signal?: AbortSignal,
): Promise<Map<number, string>> {
  if (!categoryCache) categoryCache = new TtlCache(30 * 60 * 1000, 4);
  const cached = categoryCache.get('categories');
  if (cached) return cached;
  const names = new Map<number, string>();
  try {
    const data = await deps.client.getJson<{ category_list?: { categories?: Array<{ id?: number; name?: string; slug?: string }> } }>(
      '/categories.json',
      { cacheTtlMs: 30 * 60 * 1000, signal },
    );
    for (const category of data.category_list?.categories ?? []) {
      if (typeof category.id === 'number') {
        names.set(category.id, category.name ?? category.slug ?? String(category.id));
      }
    }
  } catch {
    // 分类名属于锦上添花，失败不阻塞搜索
  }
  categoryCache.set('categories', names);
  return names;
}

export function buildSearchTool(deps: ToolDeps) {
  return defineTool({
    name: 'linuxdo_search',
    description:
      '在 Linux.do 站内搜索话题与帖子（Discourse 全文检索）。' +
      '支持 Discourse 搜索语法：@用户名 限定作者、category:分类名 限定分类、' +
      '"精确短语"、order:latest|likes|views 排序、in:title 仅搜标题。' +
      '需要读取某个话题的完整内容时，用返回的 topicId 调用 linuxdo_get_topic。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索词，支持 Discourse 搜索语法' },
      page: { type: 'integer', description: '页码，从 1 开始，默认 1' },
      typeFilter: {
        type: 'string',
        enum: ['topic', 'user', 'category'],
        description: '结果类型过滤；指定后分页才生效',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderAsText(value),
    },
    async execute(args, exec) {
      const { query, page, typeFilter } = args as {
        query: string;
        page?: number;
        typeFilter?: 'topic' | 'user' | 'category';
      };
      const data = await deps.client.getJson<Record<string, unknown>>('/search.json', {
        query: {
          q: query,
          page: page && page > 1 ? page : undefined,
          type_filter: typeFilter,
        },
        cacheTtlMs: deps.config.searchCacheTtlMs,
        signal: exec.signal,
      });
      const categories = await loadCategoryNames(deps, exec.signal);
      const view = compactSearchResult(
        data as { posts?: never[]; topics?: never[] },
        categories,
      );
      view.query = query;
      return pruneUndefined(view);
    },
    isConcurrencySafe: () => true,
  });
}

/** 供测试与状态查询复用的错误再导出。 */
export { ApiError, AuthRequiredError, ChallengeError };
