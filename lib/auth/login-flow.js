import { decryptRsaPayload } from './rsa.js';
import { AUTH_REDIRECT_DEEP_LINK, createAuthorizeContext, decryptAuthorizePayload, extractPayload, startCallbackServer, } from './authorize.js';
import { ApiError, ChallengeError, LinuxdoError } from '../core/errors.js';
/** 同一时刻只保留一个进行中的授权会话。 */
let pending;
export function getPendingLogin() {
    if (pending && Date.now() - pending.startedAt > 30 * 60 * 1000) {
        cleanupPending();
        return undefined;
    }
    return pending;
}
/** 测试辅助：强制清理进行中的授权会话与回调 server。 */
export function resetLoginFlowForTest() {
    cleanupPending();
}
function cleanupPending() {
    pending?.server?.close();
    pending = undefined;
}
/**
 * 步骤一：发起授权。
 *
 * 先尝试本地回调模式（全自动）；回调端口不可用时降级为深链 + 手动粘贴模式。
 */
export async function startLogin(config) {
    cleanupPending();
    let server;
    let redirectUri;
    try {
        server = await startCallbackServer(config);
        redirectUri = `${server.url}/callback`;
    }
    catch {
        server = undefined;
        redirectUri = AUTH_REDIRECT_DEEP_LINK;
    }
    const context = createAuthorizeContext(config, redirectUri);
    pending = { context, server, startedAt: Date.now() };
    return {
        authorizeUrl: context.authorizeUrl,
        mode: server ? 'auto' : 'manual',
        ...(server ? { callbackUrl: `${server.url}/callback` } : {}),
        expiresInSeconds: Math.floor(config.callbackTimeoutMs / 1000),
    };
}
/**
 * 步骤二：完成兑换。接受加密 payload 或完整回调 URL。
 * 自动模式下由回调 server 触发同一实现。
 */
export async function completeLoginFromPayload(client, config, rawInput) {
    const current = getPendingLogin();
    if (!current) {
        throw new LinuxdoError('NO_PENDING_LOGIN', '当前没有进行中的授权。请先调用 linuxdo_login 发起授权流程。');
    }
    const encrypted = extractPayload(rawInput);
    return finishLogin(client, config, current, encrypted);
}
/** 回调 server 收到 payload 后的内部入口。 */
export async function completeLoginFromCallback(client, config, encryptedPayload) {
    const current = getPendingLogin();
    if (!current)
        throw new LinuxdoError('NO_PENDING_LOGIN', '没有进行中的授权会话');
    return finishLogin(client, config, current, encryptedPayload);
}
async function finishLogin(client, config, pendingLogin, encryptedPayload) {
    const { context } = pendingLogin;
    const payload = decryptAuthorizePayload(context.privateKeyPem, encryptedPayload, context.nonce);
    try {
        const { tToken, username } = await exchangeOtpForSession(client, config, payload.key);
        client.adoptToken(tToken, username);
        await revokeKeyQuietly(client, config, payload.key);
        cleanupPending();
        return {
            ...(username ? { username } : {}),
            message: `Linux.do 登录成功${username ? `（${username}）` : ''}，检索工具现已可用。一次性授权 key 已用完即焚。`,
        };
    }
    catch (err) {
        // 兑换失败时保留 pending 会话，允许用户重试或改走手动路径
        throw err;
    }
}
/**
 * OTP 兑换登录态：
 * POST /user-api-key/otp（User-Api-Key 头豁免 CSRF）→ RSA 解密得 OTP
 * POST /session/otp/{otp} → Set-Cookie _t
 */
export async function exchangeOtpForSession(client, config, apiKey) {
    const otpResponse = await client.postForm('/user-api-key/otp', {}, { 'User-Api-Key': apiKey });
    if (otpResponse.status !== 200) {
        throwChallengeOrApi(otpResponse.status, otpResponse.text, '/user-api-key/otp');
    }
    const encryptedOtp = extractOtp(otpResponse.json, otpResponse.text);
    const otp = decryptRsaPayload(readPendingPrivateKey(), encryptedOtp);
    const sessionResponse = await client.postForm(`/session/otp/${encodeURIComponent(otp)}`, {});
    if (sessionResponse.status !== 200) {
        throwChallengeOrApi(sessionResponse.status, sessionResponse.text, '/session/otp/:token');
    }
    const tToken = findTokenCookie(sessionResponse.setCookies);
    if (!tToken) {
        throw new LinuxdoError('NO_SESSION_COOKIE', 'OTP 兑换响应中未找到 _t 会话 cookie。站点行为可能已变化，请携带此错误信息反馈。');
    }
    const username = readUsername(sessionResponse.json);
    return { tToken, ...(username ? { username } : {}) };
}
function readPendingPrivateKey() {
    const current = getPendingLogin();
    if (!current)
        throw new LinuxdoError('NO_PENDING_LOGIN', '没有进行中的授权会话');
    return current.context.privateKeyPem;
}
/** 响应可能是 JSON 包裹或纯文本 Base64，两种都兼容。 */
function extractOtp(json, text) {
    if (json && typeof json === 'object') {
        for (const value of Object.values(json)) {
            if (typeof value === 'string' && value.length > 0)
                return value;
        }
    }
    const trimmed = text.trim();
    if (trimmed && /^[A-Za-z0-9+/=\s]+$/.test(trimmed))
        return trimmed;
    throw new LinuxdoError('OTP_PARSE_FAILED', '无法从 /user-api-key/otp 响应中解析出加密 OTP');
}
function findTokenCookie(setCookies) {
    for (const cookie of setCookies) {
        const match = /(?:^|;\s*)_t=([^;]+)/.exec(cookie);
        if (match && match[1])
            return match[1];
    }
    return undefined;
}
function readUsername(json) {
    if (json && typeof json === 'object') {
        const user = json.user;
        if (user && typeof user === 'object') {
            const username = user.username;
            if (typeof username === 'string')
                return username;
        }
        const direct = json.current_user;
        if (direct && typeof direct === 'object') {
            const username = direct.username;
            if (typeof username === 'string')
                return username;
        }
    }
    return undefined;
}
/**
 * 用完即焚：one_time_password scope 的 key 在 linux.do 配置下是零权限永久凭据，
 * 兑换完成后立即自我吊销（revoke-self 在任何 scope 配置下都被服务端豁免）。
 */
async function revokeKeyQuietly(client, config, apiKey) {
    try {
        await client.postForm('/user-api-key/revoke', {}, { 'User-Api-Key': apiKey });
    }
    catch {
        // 吊销失败不影响登录结果；key 留在站方 Apps 列表可手动移除
    }
}
function throwChallengeOrApi(status, text, path) {
    const challengeMarkers = ['Just a moment', 'challenge-platform', 'Attention Required'];
    if (challengeMarkers.some((m) => text.includes(m)))
        throw new ChallengeError(status);
    throw new ApiError(status, path, text.slice(0, 200));
}
