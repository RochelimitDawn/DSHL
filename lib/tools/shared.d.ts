import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { DiscourseClient } from '../core/client.js';
import type { LinuxdoConfig } from '../config.js';
/**
 * 与 @deepseek-ai/dsh-session 的 JsonValue 结构等价的本地别名。
 * 该包尚未在 npm 稳定发布，避免直接依赖；TS 结构类型下完全兼容。
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
/**
 * 深度剔除 undefined 属性并收敛到 DSH 工具输出契约。
 * DSH 要求 canonical value 为纯 JsonValue（无 undefined），
 * 工具 execute 返回前统一经过本函数。
 */
export declare function pruneUndefined(value: object): Record<string, JsonValue>;
/** 工具工厂共享依赖。 */
export interface ToolDeps {
    client: DiscourseClient;
    config: LinuxdoConfig;
    log: (level: 'info' | 'warn' | 'error', message: string) => void;
}
/** 把结构化结果渲染为模型可见的 text block。 */
export declare function renderAsText(value: unknown): ContentBlock[];
interface RawSearchPost {
    id?: number;
    username?: string;
    topic_id?: number;
    blurb?: string;
    like_count?: number;
    post_number?: number;
    created_at?: string;
}
interface RawSearchTopic {
    id?: number;
    title?: string;
    slug?: string;
    posts_count?: number;
    views?: number;
    category_id?: number;
    tags?: string[];
    created_at?: string;
}
export interface SearchResultView {
    query: string;
    resultCount: number;
    results: Array<{
        topicId: number | null;
        title: string;
        postNumber: number | null;
        author: string | null;
        excerpt: string;
        likes: number | null;
        category: string | null;
        tags: string[];
    }>;
}
/**
 * 把 Discourse search.json 的 posts/topics/users 三张表 join 成扁平结果列表。
 * 字段裁剪到检索决策所需的最小集合，控制 token 占用。
 */
export declare function compactSearchResult(data: {
    posts?: RawSearchPost[];
    topics?: RawSearchTopic[];
}, categoryNameById: Map<number, string>): SearchResultView;
export interface RawCookedPost {
    post_number?: number;
    username?: string;
    created_at?: string;
    cooked?: string;
    like_count?: number;
    reply_to_post_number?: number;
}
/** 楼层渲染上下文：用于构造深链。 */
export interface PostRenderContext {
    baseUrl: string;
    topicId?: number;
    slug?: string;
}
/**
 * 单楼层渲染格式：
 * ## 3 楼 · username（3 天前）
 * [深链] 正文
 */
export declare function formatPost(post: RawCookedPost, maxChars: number, context?: PostRenderContext): {
    text: string;
    truncated: boolean;
};
export {};
