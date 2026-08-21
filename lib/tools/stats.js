import { defineTool } from '@deepseek-ai/dsh-tools';
import { pruneUndefined, renderAsText } from './shared.js';
/**
 * linuxdo_stats：请求预算自观测。
 * Agent 在长任务中可据此自主决定节流或改用本地索引。
 */
export function buildStatsTool(deps, sources) {
    return defineTool({
        name: 'linuxdo_stats',
        description: '查看本插件的请求统计：各站点请求次数、缓存命中率、限流排队、当前网络通道、' +
            '本地知识库条目数。长任务中可用来判断是否应该减少站内请求、多用本地检索。',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => renderAsText(value),
        },
        async execute(_args) {
            return pruneUndefined({
                sites: sources.clients.map(({ name, client }) => ({
                    site: name,
                    ...client.stats(),
                })),
                localIndex: sources.localIndex
                    ? { enabled: true, entries: sources.localIndex.count() }
                    : { enabled: false },
                tips: 'cacheHits 高说明重复查询正在被缓存吸收；' +
                    'queued 峰值高说明请求过于密集，建议放慢节奏或改用 linuxdo_search_local。',
            });
        },
    });
}
