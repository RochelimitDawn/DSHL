import { defineTool } from '@deepseek-ai/dsh-tools';
import { pruneUndefined, renderAsText } from './shared.js';
import { loadCategoryNames } from './search.js';
import { relativeTime } from '../core/time.js';
/**
 * linuxdo_browse：浏览话题流。
 * 覆盖"今天站内有什么热点"这类逛站场景，与搜索互补。
 */
export function buildBrowseTool(deps) {
    return defineTool({
        name: 'linuxdo_browse',
        description: '浏览 Linux.do 的话题流：latest（最新）、top（热门榜，可按日/周/月/全期）、' +
            'hot（当前热度）、new（新话题）。适合"最近站内有什么热点/新讨论"这类开放浏览需求；' +
            '有明确目标时用 linuxdo_search 或 linuxdo_semantic_search。',
        parameters: {
            stream: {
                type: 'string',
                enum: ['latest', 'top', 'hot', 'new'],
                required: true,
                description: '要浏览的流',
            },
            period: {
                type: 'string',
                enum: ['daily', 'weekly', 'monthly', 'all'],
                description: '仅 top 流有效，默认 daily',
            },
            limit: { type: 'integer', description: '返回条数，默认 20，上限 50' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => renderAsText(value),
        },
        async execute(args, exec) {
            const { stream, period, limit } = args;
            const effectiveLimit = Math.min(Math.max(limit ?? 20, 1), 50);
            const path = stream === 'top'
                ? `/top.json?period=${period ?? 'daily'}`
                : `/${stream}.json`;
            const data = await deps.client.getJson(path, {
                cacheTtlMs: deps.config.searchCacheTtlMs,
                signal: exec.signal,
            });
            const categories = await loadCategoryNames(deps, exec.signal);
            const baseUrl = deps.client.baseUrl;
            const topics = (data.topic_list?.topics ?? []).slice(0, effectiveLimit).map((topic) => ({
                topicId: topic.id,
                title: topic.title,
                category: typeof topic.category_id === 'number'
                    ? categories.get(topic.category_id) ?? null
                    : null,
                tags: topic.tags ?? [],
                posts: topic.posts_count,
                views: topic.views,
                likes: topic.like_count,
                activeAt: relativeTime(topic.bumped_at) || relativeTime(topic.created_at),
                pinned: topic.pinned === true ? true : undefined,
                permalink: topic.id !== undefined
                    ? `${baseUrl.replace(/\/+$/, '')}/t/${topic.slug ?? 'topic'}/${topic.id}`
                    : undefined,
            }));
            return pruneUndefined({ stream, ...(stream === 'top' ? { period: period ?? 'daily' } : {}), count: topics.length, topics });
        },
        isConcurrencySafe: () => true,
    });
}
