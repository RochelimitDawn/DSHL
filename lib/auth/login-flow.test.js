import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLogin, completeLoginFromCallback, getPendingLogin, resetLoginFlowForTest } from './login-flow.js';
import { encryptRsaPayload } from './rsa.js';
import { DiscourseClient } from '../core/client.js';
import { SessionStore } from './session-store.js';
import { DEFAULT_CONFIG } from '../config.js';
const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-flow-test-'));
function makeConfig() {
    return {
        ...DEFAULT_CONFIG,
        baseUrl: 'https://example.org',
        sessionFile: join(tempRoot, `flow-${Math.random().toString(36).slice(2)}.json`),
        callbackHost: '127.0.0.1',
        callbackPort: 0,
    };
}
function mockFetchForOtp(routes) {
    return async (url, init) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        for (const [pattern, handler] of routes) {
            if (urlStr.includes(pattern))
                return handler();
        }
        return new Response(JSON.stringify({ errors: ['unexpected ' + urlStr] }), { status: 500 });
    };
}
test('完整登录链路：授权 payload → OTP 兑换 → _t 落盘 → key 焚毁', async () => {
    const config = makeConfig();
    const started = await startLogin(config);
    try {
        assert.equal(started.mode, 'auto');
        assert.match(started.authorizeUrl, /\/user-api-key\/new\?/);
        assert.match(started.authorizeUrl, /scopes=one_time_password/);
        assert.match(started.authorizeUrl, /auth_redirect=http/);
        const pending = getPendingLogin();
        assert.ok(pending, 'startLogin 后应有 pending 会话');
        const { publicKeyPem, nonce, privateKeyPem } = pending.context;
        // 模拟服务端：payload 加密回传
        const encryptedPayload = encryptRsaPayload(publicKeyPem, JSON.stringify({ key: 'ONE_TIME_KEY', nonce }));
        const encryptedOtp = encryptRsaPayload(privateKeyPem, 'OTP-TOKEN-XYZ');
        let revokeCalled = false;
        const impl = mockFetchForOtp(new Map([
            [
                '/user-api-key/otp',
                () => new Response(JSON.stringify({ oneTimePassword: encryptedOtp }), { status: 200 }),
            ],
            [
                '/session/otp/OTP-TOKEN-XYZ',
                () => new Response(JSON.stringify({ current_user: { username: 'tester' } }), {
                    status: 200,
                    headers: { 'Set-Cookie': '_t=SESSION_T; Path=/; HttpOnly' },
                }),
            ],
            [
                '/user-api-key/revoke',
                () => {
                    revokeCalled = true;
                    return new Response('{}', { status: 200 });
                },
            ],
        ]));
        const sessionFile = config.sessionFile;
        writeFileSync(sessionFile, JSON.stringify({}));
        const store = new SessionStore(sessionFile);
        const client = new DiscourseClient(config, store, impl);
        const result = await completeLoginFromCallback(client, config, encryptedPayload);
        assert.match(result.message, /登录成功/);
        assert.equal(result.username, 'tester');
        assert.equal(revokeCalled, true, '零 scope key 应在兑换后被吊销');
        const fs = await import('node:fs');
        const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        assert.equal(saved.tToken, 'SESSION_T');
        assert.equal(saved.username, 'tester');
        assert.equal(getPendingLogin(), undefined, '完成后 pending 会话应清理');
    }
    finally {
        resetLoginFlowForTest();
    }
});
test('无 pending 会话时 completeLogin 报错', async () => {
    resetLoginFlowForTest();
    const config = makeConfig();
    const store = new SessionStore(config.sessionFile);
    const client = new DiscourseClient(config, store, fetch);
    await assert.rejects(completeLoginFromCallback(client, config, 'AAAA'), /没有进行中的授权会话/);
});
process.on('exit', () => {
    try {
        rmSync(tempRoot, { recursive: true, force: true });
    }
    catch {
        // 忽略
    }
});
