import { defineTool } from '@deepseek-ai/dsh-tools';
import { compactSearchResult, pruneUndefined, renderAsText } from './shared.js';
import { loadCategoryNames } from './search.js';
/**
 * linuxdo_semantic_search：站方 discourse-ai embeddings 提供的语义搜索。
 * 返回结构与标准搜索一致（GroupedSearchResultSerializer）。
 * 这是本插件相对普通爬取方案的差异化能力：向量由站方维护，天然覆盖全站内容。
 */
export function buildSemanticSearchTool(deps) {
    return defineTool({
        name: 'linuxdo_semantic_search',
        description: '在 Linux.do 站内做语义搜索（基于站方 AI 向量），按含义而非关键词匹配。' +
            '适合用自然语言描述意图的模糊查找，例如"怎么解决 Docker 端口映射不通"。' +
            '关键词精确匹配场景请改用 linuxdo_search。',
        parameters: {
            query: { type: 'string', required: true, description: '自然语言查询' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => renderAsText(value),
        },
        async execute(args, exec) {
            const { query } = args;
            const data = await deps.client.getJson('/discourse-ai/embeddings/semantic-search', {
                query: { q: query },
                cacheTtlMs: deps.config.searchCacheTtlMs,
                signal: exec.signal,
            });
            const categories = await loadCategoryNames(deps, exec.signal);
            const view = compactSearchResult(data, categories);
            view.query = query;
            if (view.resultCount === 0) {
                return {
                    query,
                    resultCount: 0,
                    results: [],
                    hint: '语义搜索无结果。站点可能未开启 discourse-ai 插件，请改用 linuxdo_search 关键词搜索。',
                };
            }
            return pruneUndefined(view);
        },
        isConcurrencySafe: () => true,
    });
}
