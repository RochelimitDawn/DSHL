import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscourseClient } from './client.js';
import { SessionStore } from '../auth/session-store.js';
import { AuthRequiredError, ChallengeError } from './errors.js';
import { DEFAULT_CONFIG } from '../config.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-client-test-'));

function makeSessionFile(): string {
  return join(tempRoot, `session-${Math.random().toString(36).slice(2)}.json`);
}

function makeConfig(sessionFile: string) {
  return {
    ...DEFAULT_CONFIG,
    baseUrl: 'https://example.org',
    sessionFile,
    maxConcurrent: 4,
    windowMax: 100,
    windowSeconds: 1,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: urlStr, init });
    return handler(urlStr, init);
  };
  return { impl: impl as typeof fetch, calls };
}

test('getJson 携带浏览器形态头与登录 cookie', async () => {
  const sessionFile = makeSessionFile();
  writeFileSync(sessionFile, JSON.stringify({ tToken: 'TOKEN123' }));
  const store = new SessionStore(sessionFile);
  const { impl, calls } = mockFetch(
    () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const client = new DiscourseClient(makeConfig(sessionFile), store, impl);
  await client.getJson('/latest.json');

  assert.equal(calls.length, 1);
  const headers = new Headers(calls[0]!.init!.headers);
  assert.equal(headers.get('Cookie'), '_t=TOKEN123');
  assert.equal(headers.get('X-Requested-With'), 'XMLHttpRequest');
  assert.match(headers.get('Accept') ?? '', /application\/json/);
  assert.ok((headers.get('User-Agent') ?? '').includes('Mozilla'));
});

test('getJson 命中缓存时第二次请求不发出', async () => {
  const sessionFile = makeSessionFile();
  const store = new SessionStore(sessionFile);
  const { impl, calls } = mockFetch(
    () => new Response(JSON.stringify({ n: 1 }), { status: 200 }),
  );
  const client = new DiscourseClient(makeConfig(sessionFile), store, impl);
  await client.getJson('/t/1.json');
  await client.getJson('/t/1.json');
  assert.equal(calls.length, 1);
});

test('Cloudflare 挑战页抛 ChallengeError', async () => {
  const store = new SessionStore(makeSessionFile());
  const { impl } = mockFetch(
    () => new Response('<html>Just a moment...</html>', { status: 403 }),
  );
  const client = new DiscourseClient(makeConfig(makeSessionFile()), store, impl);
  await assert.rejects(client.getJson('/latest.json'), ChallengeError);
});

test('401 抛 AuthRequiredError', async () => {
  const store = new SessionStore(makeSessionFile());
  const { impl } = mockFetch(() => new Response('{"errors":["未登录"]}', { status: 401 }));
  const client = new DiscourseClient(makeConfig(makeSessionFile()), store, impl);
  await assert.rejects(client.getJson('/session/current.json'), AuthRequiredError);
});

test('响应 Set-Cookie 中的 _t 续期回写会话文件', async () => {
  const sessionFile = makeSessionFile();
  writeFileSync(sessionFile, JSON.stringify({ tToken: 'OLD' }));
  const store = new SessionStore(sessionFile);
  const { impl } = mockFetch(
    () =>
      new Response('{}', {
        status: 200,
        headers: { 'Set-Cookie': '_t=NEW_TOKEN; path=/; HttpOnly' },
      }),
  );
  const client = new DiscourseClient(makeConfig(sessionFile), store, impl);
  await client.getJson('/t/9.json');
  const saved = JSON.parse(readFileSync(sessionFile, 'utf8')) as { tToken?: string };
  assert.equal(saved.tToken, 'NEW_TOKEN');
});

process.on('exit', () => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // 忽略
  }
});
