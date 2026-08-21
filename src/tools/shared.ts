import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { htmlToText } from '../transform/html.js';
import { relativeTime, topicPermalink } from '../core/time.js';
import type { DiscourseClient } from '../core/client.js';
import type { LinuxdoConfig } from '../config.js';

/**
 * 与 @deepseek-ai/dsh-session 的 JsonValue 结构等价的本地别名。
 * 该包尚未在 npm 稳定发布，避免直接依赖；TS 结构类型下完全兼容。
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * 深度剔除 undefined 属性并收敛到 DSH 工具输出契约。
 * DSH 要求 canonical value 为纯 JsonValue（无 undefined），
 * 工具 execute 返回前统一经过本函数。
 */
export function pruneUndefined(value: object): Record<string, JsonValue> {
  function walk(item: unknown): JsonValue {
    if (Array.isArray(item)) return item.map((entry) => walk(entry));
    if (item !== null && typeof item === 'object') {
      const out: Record<string, JsonValue> = {};
      for (const [key, entry] of Object.entries(item)) {
        if (entry !== undefined) out[key] = walk(entry);
      }
      return out;
    }
    return item === undefined ? null : (item as JsonValue);
  }
  return (value !== null && typeof value === 'object' ? walk(value) : {}) as Record<string, JsonValue>;
}

/** 工具工厂共享依赖。 */
export interface ToolDeps {
  client: DiscourseClient;
  config: LinuxdoConfig;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** 把结构化结果渲染为模型可见的 text block。 */
export function renderAsText(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

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
export function compactSearchResult(
  data: { posts?: RawSearchPost[]; topics?: RawSearchTopic[] },
  categoryNameById: Map<number, string>,
): SearchResultView {
  const topicsById = new Map<number, RawSearchTopic>();
  for (const topic of data.topics ?? []) {
    if (typeof topic.id === 'number') topicsById.set(topic.id, topic);
  }
  const results: SearchResultView['results'] = [];
  for (const post of data.posts ?? []) {
    const topic = typeof post.topic_id === 'number' ? topicsById.get(post.topic_id) : undefined;
    results.push({
      topicId: post.topic_id ?? null,
      title: topic?.title ?? '(未知话题)',
      postNumber: post.post_number ?? null,
      author: post.username ?? null,
      excerpt: post.blurb ?? '',
      likes: post.like_count ?? null,
      category:
        typeof topic?.category_id === 'number'
          ? categoryNameById.get(topic.category_id) ?? null
          : null,
      tags: topic?.tags ?? [],
    });
  }
  return {
    query: '',
    resultCount: results.length,
    results,
  };
}

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
export function formatPost(
  post: RawCookedPost,
  maxChars: number,
  context?: PostRenderContext,
): { text: string; truncated: boolean } {
  const timeLabel = relativeTime(post.created_at);
  const headerParts = [
    `## ${post.post_number ?? '?'} 楼 · ${post.username ?? '匿名'}`,
    timeLabel ? `(${timeLabel})` : (post.created_at ? `(${post.created_at})` : ''),
  ].filter(Boolean);
  let header = headerParts.join(' ');
  if (context?.topicId !== undefined) {
    const link = topicPermalink(context.baseUrl, context.slug, context.topicId, post.post_number);
    header += `\n${link}`;
  }
  const body = htmlToTextSafe(post.cooked ?? '');
  const full = `${header}\n${body}`;
  if (full.length <= maxChars) return { text: full, truncated: false };
  return { text: `${full.slice(0, maxChars)}\n[内容已截断]`, truncated: true };
}

function htmlToTextSafe(html: string): string {
  return htmlToText(html);
}
