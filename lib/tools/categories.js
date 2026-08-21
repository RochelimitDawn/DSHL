import { defineTool } from '@deepseek-ai/dsh-tools';
import { pruneUndefined, renderAsText } from './shared.js';
/** linuxdo_list_categories：列出站点分类，供检索时限定范围。 */
export function buildListCategoriesTool(deps) {
    return defineTool({
        name: 'linuxdo_list_categories',
        description: '列出 Linux.do 的全部分类（含描述与话题量）。' +
            '在构造 linuxdo_search 的 category: 过滤条件前可先调用本工具了解分类体系。',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => renderAsText(value),
        },
        async execute(_args, exec) {
            const data = await deps.client.getJson('/categories.json', { cacheTtlMs: 30 * 60 * 1000, signal: exec.signal });
            const categories = (data.category_list?.categories ?? []).map((category) => ({
                id: category.id,
                name: category.name ?? category.slug,
                slug: category.slug,
                topics: category.topic_count,
                description: (category.description_text ?? category.description_excerpt ?? '')
                    .slice(0, 200),
                restricted: category.read_restricted === true,
            }));
            return pruneUndefined({
                total: categories.length,
                categories,
            });
        },
        isConcurrencySafe: () => true,
    });
}
