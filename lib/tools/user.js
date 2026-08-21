import { defineTool } from '@deepseek-ai/dsh-tools';
import { pruneUndefined, renderAsText } from './shared.js';
/** linuxdo_get_user：查询站内用户公开资料。 */
export function buildGetUserTool(deps) {
    return defineTool({
        name: 'linuxdo_get_user',
        description: '查询 Linux.do 站内用户的公开资料：头衔、信任等级、发帖/话题数、徽章数、简介等。',
        parameters: {
            username: { type: 'string', required: true, description: '用户名' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => renderAsText(value),
        },
        async execute(args, exec) {
            const { username } = args;
            const data = await deps.client.getJson(`/u/${encodeURIComponent(username)}.json`, { cacheTtlMs: deps.config.searchCacheTtlMs, signal: exec.signal });
            const user = data.user ?? {};
            return pruneUndefined({
                username: user.username ?? username,
                displayName: user.name,
                title: user.title,
                trustLevel: user.trust_level,
                badgeCount: user.badge_count,
                postCount: user.post_count,
                topicCount: user.topic_count,
                memberSince: user.created_at,
                lastSeenAt: user.last_seen_at,
                website: user.website_name,
                bio: (user.bio_raw ?? '').slice(0, 500),
                groups: (user.groups ?? [])
                    .map((g) => g.full_name || g.name)
                    .filter((n) => Boolean(n))
                    .slice(0, 10),
            });
        },
        isConcurrencySafe: () => true,
    });
}
