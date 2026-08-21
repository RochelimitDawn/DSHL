import { defineTool } from '@deepseek-ai/dsh-tools';
import { formatPost, pruneUndefined, renderAsText, type JsonValue, type RawCookedPost, type ToolDeps } from './shared.js';
import { truncateText } from '../transform/html.js';
import { TopicCursorStore } from '../core/topic-cursor-store.js';
import { LocalIndex } from '../core/local-index.js';
import { relativeTime, topicPermalink } from '../core/time.js';

interface TopicDetailResponse {
  id?: number;
  title?: string;
  slug?: string;
  posts_count?: number;
  created_at?: string;
  category_id?: number;
  tags?: string[];
  views?: number;
  like_count?: number;
  details?: {
    created_by?: { username?: string };
    participants?: Array<{ username?: string; post_count?: number }>;
  };
  post_stream?: {
    stream?: number[];
    posts?: RawCookedPost[];
  };
}

export interface GetTopicExtras {
  cursors: TopicCursorStore;
  localIndex: LocalIndex | undefined;
}

/**
 * linuxdo_get_topic：读取话题内容。
 *
 * token 控制四件套：
 * 1. cooked HTML 清洗为纯文本（引用自动折叠）
 * 2. 楼层窗口分页（fromPostNumber + maxPosts）
 * 3. maxChars 硬上限截断 + nextFromPostNumber 续读游标
 * 4. mode=incremental 增量模式：只返回上次读取后的新楼
 *
 * 每次成功读取都会沉淀到本地 FTS5 知识库（启用时）。
 */
export function buildGetTopicTool(deps: ToolDeps, extras: GetTopicExtras) {
  return defineTool({
    name: 'linuxdo_get_topic',
    description:
      '读取 Linux.do 一个话题的完整内容（按楼层）。' +
      '大话题自动分页：首次调用省略 fromPostNumber 从第 1 楼开始；' +
      '若结果带 nextFromPostNumber 字段，用它继续调用即可读后续楼层。' +
      '跟踪已读过的话题有无更新时用 mode="incremental"，只返回新楼，大幅节省 token。',
    parameters: {
      topicId: { type: 'integer', required: true, description: '话题 ID（linuxdo_search 结果中的 topicId）' },
      fromPostNumber: { type: 'integer', description: '起始楼层号，默认 1；续读时传上一次返回的 nextFromPostNumber' },
      maxPosts: { type: 'integer', description: '本次最多读取的楼层数，默认 20，上限 50' },
      mode: {
        type: 'string',
        enum: ['full', 'incremental'],
        description: 'incremental = 从上次读取位置继续，只取新楼；默认 full',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderAsText(value),
    },
    async execute(args, exec) {
      const { topicId, fromPostNumber, maxPosts, mode } = args as {
        topicId: number;
        fromPostNumber?: number;
        maxPosts?: number;
        mode?: 'full' | 'incremental';
      };
      const effectiveMaxPosts = Math.min(Math.max(maxPosts ?? 20, 1), 50);

      // 增量模式：先查游标
      let effectiveFrom = fromPostNumber;
      if (mode === 'incremental' && fromPostNumber === undefined) {
        const cursor = extras.cursors.get(topicId);
        if (cursor) {
          const probe = await deps.client.getJson<TopicDetailResponse>(`/t/${topicId}.json`, {
            cacheTtlMs: 0,
            signal: exec.signal,
          });
          const total = probe.post_stream?.stream?.length ?? probe.posts_count ?? 0;
          if (total <= cursor.lastPostNumber) {
            return pruneUndefined({
              topicId,
              title: probe.title,
              noNewPosts: true,
              totalPosts: total,
              lastReadAtLabel: relativeTime(cursor.lastReadAt),
              hint: `自上次阅读（${relativeTime(cursor.lastReadAt)}）以来没有新回复。`,
            });
          }
          effectiveFrom = cursor.lastPostNumber + 1;
          // 复用 probe 已带的首屏数据判断新楼是否在其中
          return renderTopic(deps, extras, probe, effectiveFrom, effectiveMaxPosts, true);
        }
      }

      const path =
        effectiveFrom !== undefined && effectiveFrom > 1
          ? `/t/${topicId}/${effectiveFrom}.json`
          : `/t/${topicId}.json`;
      const data = await deps.client.getJson<TopicDetailResponse>(path, {
        cacheTtlMs: deps.config.topicCacheTtlMs,
        signal: exec.signal,
      });
      return renderTopic(deps, extras, data, effectiveFrom ?? 1, effectiveMaxPosts, false);
    },
    isConcurrencySafe: () => true,
  });
}

async function renderTopic(
  deps: ToolDeps,
  extras: GetTopicExtras,
  data: TopicDetailResponse,
  fromPostNumber: number,
  effectiveMaxPosts: number,
  incremental: boolean,
): Promise<Record<string, JsonValue>> {
  const topicId = data.id ?? 0;
  const allPosts = data.post_stream?.posts ?? [];
  const totalPosts = data.post_stream?.stream?.length ?? data.posts_count ?? allPosts.length;

  // 只渲染 >= fromPostNumber 的楼层（增量/续读语义）
  const visiblePosts =
    incremental || fromPostNumber > 1
      ? allPosts.filter((p) => (p.post_number ?? 0) >= fromPostNumber)
      : allPosts;

  const context = {
    baseUrl: deps.client.baseUrl,
    topicId: data.id,
    slug: data.slug,
  };

  let budget = deps.config.maxOutputChars;
  const rendered: string[] = [];
  let lastPostNumber = fromPostNumber - 1;
  let truncatedByBudget = false;
  for (const post of visiblePosts.slice(0, effectiveMaxPosts)) {
    const formatted = formatPost(post, Math.max(budget, 500), context);
    if (formatted.text.length > budget) {
      truncatedByBudget = true;
      break;
    }
    rendered.push(formatted.text);
    budget -= formatted.text.length + 1;
    lastPostNumber = post.post_number ?? lastPostNumber;
    if (formatted.truncated) break;
  }

  // 本地知识库沉淀（fire-and-forget，失败静默）
  if (extras.localIndex && data.id !== undefined) {
    for (const post of visiblePosts.slice(0, rendered.length)) {
      try {
        extras.localIndex.index({
          site: new URL(deps.client.baseUrl).host,
          topicId: data.id,
          postId: Number(`${data.id}${String(post.post_number ?? 0).padStart(5, '0')}`),
          postNumber: post.post_number ?? 0,
          title: data.title ?? '',
          author: post.username ?? '',
          content: stripMarkdownHeaders(formatPost(post, 4000).text),
          url: topicPermalink(deps.client.baseUrl, data.slug, data.id, post.post_number),
        });
      } catch {
        // 索引失败不影响主流程
      }
    }
  }

  if (lastPostNumber >= fromPostNumber) {
    extras.cursors.set(topicId, Math.max(lastPostNumber, fromPostNumber));
  }

  const hasMoreFloors = lastPostNumber < totalPosts;
  const result: Record<string, unknown> = {
    topicId: data.id ?? topicId,
    title: data.title,
    category_id: data.category_id,
    tags: data.tags ?? [],
    createdBy: data.details?.created_by?.username,
    createdAt: relativeTime(data.created_at) || data.created_at,
    totalPosts,
    postsRead: rendered.length,
    ...(incremental ? { mode: 'incremental' } : {}),
    permalink: topicPermalink(deps.client.baseUrl, data.slug, data.id ?? topicId),
    floors: rendered.join('\n\n'),
  };
  if (rendered.length < Math.min(visiblePosts.length, effectiveMaxPosts) || (truncatedByBudget && hasMoreFloors)) {
    result.truncated = true;
  }
  if (hasMoreFloors && rendered.length > 0) {
    result.nextFromPostNumber = lastPostNumber + 1;
  }
  if (rendered.length === 0) {
    result.floors = '(该楼层范围内没有可显示的内容)';
  }
  return pruneUndefined(result);
}

function stripMarkdownHeaders(text: string): string {
  return text.replace(/^## .*$/m, '').trim();
}
