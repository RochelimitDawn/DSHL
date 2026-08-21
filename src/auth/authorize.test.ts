import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decryptAuthorizePayload,
  extractPayload,
  startCallbackServer,
} from './authorize.js';
import { encryptRsaPayload, generateRsaKeyPair } from './rsa.js';
import { DEFAULT_CONFIG } from '../config.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-linuxdo-test-'));

function testConfig(overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
  return { ...DEFAULT_CONFIG, sessionFile: join(tempRoot, 'unused.json'), ...overrides };
}

test('extractPayload 兼容三种输入形态', () => {
  const payload = 'AbC+/123==';
  assert.equal(
    extractPayload(`http://127.0.0.1:54321/callback?payload=${encodeURIComponent(payload)}`),
    payload,
  );
  assert.equal(
    extractPayload(`discourse://auth_redirect?payload=${encodeURIComponent(payload)}&extra=1`),
    payload,
  );
  assert.equal(extractPayload('  AbC+/123==  '), 'AbC+/123==');
});

test('extractPayload 拒绝无效输入', () => {
  assert.throws(() => extractPayload(''), /输入为空/);
  assert.throws(() => extractPayload('not a url!'), /无法从输入中识别/);
});

test('decryptAuthorizePayload 解密并校验 nonce', () => {
  const keys = generateRsaKeyPair();
  const nonce = 'nonce-123';
  const encrypted = encryptRsaPayload(
    keys.publicKeyPem,
    JSON.stringify({ key: 'k-1', nonce }),
  );
  const payload = decryptAuthorizePayload(keys.privateKeyPem, encrypted, nonce);
  assert.equal(payload.key, 'k-1');
});

test('decryptAuthorizePayload nonce 不匹配时报错', () => {
  const keys = generateRsaKeyPair();
  const encrypted = encryptRsaPayload(
    keys.publicKeyPem,
    JSON.stringify({ key: 'k-1', nonce: 'other' }),
  );
  assert.throws(() => decryptAuthorizePayload(keys.privateKeyPem, encrypted, 'expected'), /nonce 校验失败/);
});

test('本地回调 server 接收 payload 并响应成功页', async () => {
  const server = await startCallbackServer(testConfig({ callbackHost: '127.0.0.1', callbackPort: 0 }));
  try {
    const waiting = server.waitForPayload(5000);
    const response = await fetch(`${server.url}/callback?payload=HELLO`);
    const html = await response.text();
    assert.match(html, /授权成功/);
    assert.equal(await waiting, 'HELLO');
  } finally {
    server.close();
  }
});

test('回调缺 payload 时页面提示异常且不 resolve', async () => {
  const server = await startCallbackServer(testConfig({ callbackHost: '127.0.0.1', callbackPort: 0 }));
  try {
    const waiting = server.waitForPayload(3000);
    const response = await fetch(`${server.url}/callback`);
    const html = await response.text();
    assert.match(html, /授权异常/);
    await assert.rejects(waiting, /超时/);
  } finally {
    server.close();
  }
});

// 清理临时目录
process.on('exit', () => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
});
