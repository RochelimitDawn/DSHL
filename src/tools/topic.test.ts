import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { DiscourseClient } from '../core/client.js';
import { SessionStore } from '../auth/session-store.js';
import { TopicCursorStore } from '../core/topic-cursor-store.js';
import { DEFAULT_CONFIG } from '../config.js';
import { buildGetTopicTool, type GetTopicExtras } from './topic.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-topic-test-'));

function makeDeps() {
  const sessionFile = join(tempRoot, `s-${Math.random().toString(36).slice(2)}.json`);
  const cursorsFile = join(tempRoot, `c-${Math.random().toString(36).slice(2)}.json`);
  const config = {
    ...DEFAULT_CONFIG,
    baseUrl: 'https://example.org',
    sessionFile,
    maxConcurrent: 4,
    windowMax: 100,
    windowSeconds: 1,
    localIndexEnabled: false,
  };
  const store = new SessionStore(sessionFile);
  writeToken(store);

  const routes = new Map<string, () => Response>();
  const impl = async (url: string | URL): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for (const [pattern, handler] of routes) {
      if (urlStr.includes(pattern)) return handler();
    }
    return new Response('{}', { status: 404 });
  };
  const client = new DiscourseClient(config, store, impl as typeof fetch);
  const deps = {
    client,
    config,
    log: () => undefined,
  };
  const extras: GetTopicExtras = {
    cursors: new TopicCursorStore(cursorsFile),
    localIndex: undefined,
  };
  return { deps, extras, routes };
}

function writeToken(store: SessionStore): void {
  store.save({ tToken: 'T' });
}

const TOPIC_55 = {
  id: 55,
  title: '测试话题',
  slug: 'test-topic',
  posts_count: 3,
  post_stream: {
    stream: [1, 2, 3],
    posts: [
      { post_number: 1, username: 'op', created_at: '2026-08-01T00:00:00Z', cooked: '<p>一楼</p>' },
      { post_number: 2, username: 'a', created_at: '2026-08-02T00:00:00Z', cooked: '<p>二楼</p>' },
      { post_number: 3, username: 'b', created_at: '2026-08-03T00:00:00Z', cooked: '<p>三楼</p>' },
    ],
  },
};

test('get_topic 全量模式：渲染楼层与深链并记录游标', async () => {
  const { deps, extras, routes } = makeDeps();
  routes.set('/t/55.json', () => new Response(JSON.stringify(TOPIC_55), { status: 200 }));
  const tool = buildGetTopicTool(deps, extras);
  const result = (await tool.execute({ topicId: 55 }, stubExec())) as Record<string, unknown>;

  assert.equal(result.topicId, 55);
  const floors = String(result.floors);
  assert.match(floors, /一楼/);
  assert.match(floors, /三楼/);
  assert.match(floors, /https:\/\/example\.org\/t\/test-topic\/55\//);
  assert.equal(result.nextFromPostNumber, undefined, '全部楼层已读完无续读游标');

  // 游标已记录到第 3 楼
  assert.equal(extras.cursors.get(55)?.lastPostNumber, 3);
});

test('get_topic 增量模式：无新楼返回 noNewPosts', async () => {
  const { deps, extras, routes } = makeDeps();
  routes.set('/t/66.json', () => new Response(JSON.stringify({ ...TOPIC_55, id: 66 }), { status: 200 }));
  const tool = buildGetTopicTool(deps, extras);
  await tool.execute({ topicId: 66 }, stubExec());
  const second = (await tool.execute(
    { topicId: 66, mode: 'incremental' },
    stubExec(),
  )) as Record<string, unknown>;
  assert.equal(second.noNewPosts, true);
  assert.ok(String(second.hint).includes('没有新回复'));
});

test('get_topic 增量模式：有新楼只返回新增部分', async () => {
  const { deps, extras, routes } = makeDeps();
  let postsCount = 3;
  routes.set('/t/77.json', () => {
    if (postsCount === 3) {
      return new Response(JSON.stringify({ ...TOPIC_55, id: 77 }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        ...TOPIC_55,
        id: 77,
        posts_count: postsCount,
        post_stream: {
          stream: Array.from({ length: postsCount }, (_, i) => i + 1),
          posts: [
            ...TOPIC_55.post_stream.posts,
            { post_number: 4, username: 'newbie', created_at: '2026-08-20T00:00:00Z', cooked: '<p>四楼新回复</p>' },
          ],
        },
      }),
      { status: 200 },
    );
  });
  const tool = buildGetTopicTool(deps, extras);
  await tool.execute({ topicId: 77 }, stubExec());

  postsCount = 4;
  const incremental = (await tool.execute(
    { topicId: 77, mode: 'incremental' },
    stubExec(),
  )) as Record<string, unknown>;
  const floors = String(incremental.floors);
  assert.match(floors, /四楼新回复/);
  assert.doesNotMatch(floors, /一楼/);
  // 已读到最新楼层：游标推进到 4 且无续读提示
  assert.equal(extras.cursors.get(77)?.lastPostNumber, 4);
  assert.equal(incremental.nextFromPostNumber, undefined);
});

function stubExec(): ToolRunContext {
  return {
    signal: new AbortController().signal,
    callId: 'test-call',
    rootCallId: 'test-call',
    name: 'test',
    arguments: {},
    token: Symbol('token'),
    deferContext: () => undefined,
    concludeTurn: () => undefined,
  } as unknown as ToolRunContext;
}

process.on('exit', () => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // 忽略
  }
});
