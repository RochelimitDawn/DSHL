import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime, topicPermalink } from './time.js';
const NOW = Date.parse('2026-08-21T12:00:00Z');
test('relativeTime 各时间档位', () => {
    assert.equal(relativeTime('2026-08-21T11:59:40Z', NOW), '刚刚');
    assert.equal(relativeTime('2026-08-21T11:35:00Z', NOW), '25 分钟前');
    assert.equal(relativeTime('2026-08-21T06:00:00Z', NOW), '6 小时前');
    assert.equal(relativeTime('2026-08-15T12:00:00Z', NOW), '6 天前');
    assert.equal(relativeTime('2026-05-01T12:00:00Z', NOW), '3 个月前');
});
test('relativeTime 超过一年退化为日期', () => {
    assert.equal(relativeTime('2024-06-01T12:00:00Z', NOW), '2024-06-01');
});
test('relativeTime 无效输入原样返回', () => {
    assert.equal(relativeTime(undefined), '');
    assert.equal(relativeTime('not-a-date'), 'not-a-date');
});
test('topicPermalink 构造标准 Discourse URL', () => {
    assert.equal(topicPermalink('https://linux.do/', 'some-slug', 123, 5), 'https://linux.do/t/some-slug/123/5');
    assert.equal(topicPermalink('https://linux.do', undefined, 123), 'https://linux.do/t/topic/123');
});
