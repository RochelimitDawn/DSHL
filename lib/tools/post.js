import { defineTool } from '@deepseek-ai/dsh-tools';
import { htmlToText, truncateText } from '../transform/html.js';
import { pruneUndefined, renderAsText } from './shared.js';
/** linuxdo_get_post：按帖子 ID 读取单楼内容。 */
export function buildGetPostTool(deps) {
    return defineTool({
        name: 'linuxdo_get_post',
        description: '按帖子 ID 读取 Linux.do 单个楼层的内容。' +
            '通常用 linuxdo_get_topic 按话题阅读即可；本工具用于搜索结果中只有 postId 的场景。',
        parameters: {
            postId: { type: 'integer', required: true, description: '帖子 ID' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => renderAsText(value),
        },
        async execute(args, exec) {
            const { postId } = args;
            const data = await deps.client.getJson(`/posts/${postId}.json`, {
                cacheTtlMs: deps.config.topicCacheTtlMs,
                signal: exec.signal,
            });
            const text = htmlToText(data.cooked ?? '');
            const clipped = truncateText(text, deps.config.maxOutputChars);
            return pruneUndefined({
                postId: data.id ?? postId,
                topicId: data.topic_id,
                postNumber: data.post_number,
                author: data.username,
                createdAt: data.created_at,
                likes: data.like_count,
                content: clipped.text,
                truncated: clipped.truncated,
            });
        },
        isConcurrencySafe: () => true,
    });
}
