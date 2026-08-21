import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cjkBigram, LocalIndex } from './local-index.js';

test('cjkBigram 中文两两成组', () => {
  assert.equal(cjkBigram('中文检索'), '中文 文检 检索');
});

test('cjkBigram 混合文本', () => {
  const result = cjkBigram('Docker 部署');
  assert.match(result, /Docker/);
  assert.match(result, /部署/);
});

test('LocalIndex 内存库：写入与检索 roundtrip', () => {
  const index = new LocalIndex(':memory:');
  index.index({
    site: 'linux.do',
    topicId: 1,
    postId: 100001,
    postNumber: 1,
    title: 'Docker 端口映射排查指南',
    author: 'alice',
    content: '遇到端口映射不通时先检查 iptables 规则和监听地址。',
    url: 'https://linux.do/t/t/1/1',
  });
  index.index({
    site: 'linux.do',
    topicId: 2,
    postId: 200001,
    postNumber: 1,
    title: 'Rust 异步运行时对比',
    author: 'bob',
    content: 'tokio 与 smol 的设计取舍分析。',
    url: 'https://linux.do/t/t/2/1',
  });

  assert.equal(index.count(), 2);

  const hits = index.search('端口映射');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.postId, 100001);
  assert.match(hits[0]!.title, /端口/);

  const enHits = index.search('tokio');
  assert.equal(enHits.length, 1);
  assert.equal(enHits[0]!.author, 'bob');

  // 单字 CJK 查询（bigram 覆盖不到）应安全返回空而非报错
  assert.deepEqual(index.search('部'), []);
});

test('LocalIndex 同帖更新不重复计数', () => {
  const index = new LocalIndex(':memory:');
  const base = {
    site: 's',
    topicId: 9,
    postId: 42,
    postNumber: 3,
    title: 't',
    author: 'u',
    content: '内容一',
    url: 'u',
  };
  index.index(base);
  index.index({ ...base, content: '内容二' });
  assert.equal(index.count(), 1);
});
