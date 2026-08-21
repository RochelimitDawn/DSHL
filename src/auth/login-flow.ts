import { decryptRsaPayload } from './rsa.js';
import {
  AUTH_REDIRECT_DEEP_LINK,
  createAuthorizeContext,
  decryptAuthorizePayload,
  extractPayload,
  startCallbackServer,
  type AuthorizeContext,
  type CallbackServer,
} from './authorize.js';
import type { DiscourseClient } from '../core/client.js';
import type { LinuxdoConfig } from '../config.js';
import { ApiError, ChallengeError, LinuxdoError } from '../core/errors.js';

/**
 * 登录流程编排。
 *
 * 对 Agent 暴露为三个工具协作的无状态步骤：
 * - linuxdo_login        发起授权：返回授权 URL 并启动本地回调等待
 * - linuxdo_login_complete 手动路径：粘贴回调 URL 完成兑换
 * - linuxdo_auth_status  查询会话状态
 */

export interface LoginStartResult {
  authorizeUrl: string;
  /** auto = 本地回调已就绪，授权后自动完成；manual = 需要用户粘贴回调 URL */
  mode: 'auto' | 'manual';
  callbackUrl?: string;
  expiresInSeconds: number;
}

export interface LoginCompleteResult {
  username?: string;
  message: string;
}

interface PendingLogin {
  context: AuthorizeContext;
  server?: CallbackServer;
  startedAt: number;
}

/** 同一时刻只保留一个进行中的授权会话。 */
let pending: PendingLogin | undefined;

export function getPendingLogin(): PendingLogin | undefined {
  if (pending && Date.now() - pending.startedAt > 30 * 60 * 1000) {
    cleanupPending();
    return undefined;
  }
  return pending;
}

/** 测试辅助：强制清理进行中的授权会话与回调 server。 */
export function resetLoginFlowForTest(): void {
  cleanupPending();
}

function cleanupPending(): void {
  pending?.server?.close();
  pending = undefined;
}

/**
 * 步骤一：发起授权。
 *
 * 先尝试本地回调模式（全自动）；回调端口不可用时降级为深链 + 手动粘贴模式。
 */
export async function startLogin(
  config: LinuxdoConfig,
): Promise<LoginStartResult> {
  cleanupPending();

  let server: CallbackServer | undefined;
  let redirectUri: string;
  try {
    server = await startCallbackServer(config);
    redirectUri = `${server.url}/callback`;
  } catch {
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
export async function completeLoginFromPayload(
  client: DiscourseClient,
  config: LinuxdoConfig,
  rawInput: string,
): Promise<LoginCompleteResult> {
  const current = getPendingLogin();
  if (!current) {
    throw new LinuxdoError(
      'NO_PENDING_LOGIN',
      '当前没有进行中的授权。请先调用 linuxdo_login 发起授权流程。',
    );
  }
  const encrypted = extractPayload(rawInput);
  return finishLogin(client, config, current, encrypted);
}

/** 回调 server 收到 payload 后的内部入口。 */
export async function completeLoginFromCallback(
  client: DiscourseClient,
  config: LinuxdoConfig,
  encryptedPayload: string,
): Promise<LoginCompleteResult> {
  const current = getPendingLogin();
  if (!current) throw new LinuxdoError('NO_PENDING_LOGIN', '没有进行中的授权会话');
  return finishLogin(client, config, current, encryptedPayload);
}

async function finishLogin(
  client: DiscourseClient,
  config: LinuxdoConfig,
  pendingLogin: PendingLogin,
  encryptedPayload: string,
): Promise<LoginCompleteResult> {
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
  } catch (err) {
    // 兑换失败时保留 pending 会话，允许用户重试或改走手动路径
    throw err;
  }
}

/**
 * OTP 兑换登录态：
 * POST /user-api-key/otp（User-Api-Key 头豁免 CSRF）→ RSA 解密得 OTP
 * POST /session/otp/{otp} → Set-Cookie _t
 */
export async function exchangeOtpForSession(
  client: DiscourseClient,
  config: LinuxdoConfig,
  apiKey: string,
): Promise<{ tToken: string; username?: string }> {
  const otpResponse = await client.postForm(
    '/user-api-key/otp',
    {},
    { 'User-Api-Key': apiKey },
  );
  if (otpResponse.status !== 200) {
    throwChallengeOrApi(otpResponse.status, otpResponse.text, '/user-api-key/otp');
  }
  const encryptedOtp = extractOtp(otpResponse.json, otpResponse.text);
  const otp = decryptRsaPayload(readPendingPrivateKey(), encryptedOtp);

  const sessionResponse = await client.postForm(
    `/session/otp/${encodeURIComponent(otp)}`,
    {},
  );
  if (sessionResponse.status !== 200) {
    throwChallengeOrApi(sessionResponse.status, sessionResponse.text, '/session/otp/:token');
  }

  const tToken = findTokenCookie(sessionResponse.setCookies);
  if (!tToken) {
    throw new LinuxdoError(
      'NO_SESSION_COOKIE',
      'OTP 兑换响应中未找到 _t 会话 cookie。站点行为可能已变化，请携带此错误信息反馈。',
    );
  }
  const username = readUsername(sessionResponse.json);
  return { tToken, ...(username ? { username } : {}) };
}

function readPendingPrivateKey(): string {
  const current = getPendingLogin();
  if (!current) throw new LinuxdoError('NO_PENDING_LOGIN', '没有进行中的授权会话');
  return current.context.privateKeyPem;
}

/** 响应可能是 JSON 包裹或纯文本 Base64，两种都兼容。 */
function extractOtp(json: unknown, text: string): string {
  if (json && typeof json === 'object') {
    for (const value of Object.values(json as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  const trimmed = text.trim();
  if (trimmed && /^[A-Za-z0-9+/=\s]+$/.test(trimmed)) return trimmed;
  throw new LinuxdoError('OTP_PARSE_FAILED', '无法从 /user-api-key/otp 响应中解析出加密 OTP');
}

function findTokenCookie(setCookies: string[]): string | undefined {
  for (const cookie of setCookies) {
    const match = /(?:^|;\s*)_t=([^;]+)/.exec(cookie);
    if (match && match[1]) return match[1];
  }
  return undefined;
}

function readUsername(json: unknown): string | undefined {
  if (json && typeof json === 'object') {
    const user = (json as Record<string, unknown>).user;
    if (user && typeof user === 'object') {
      const username = (user as Record<string, unknown>).username;
      if (typeof username === 'string') return username;
    }
    const direct = (json as Record<string, unknown>).current_user;
    if (direct && typeof direct === 'object') {
      const username = (direct as Record<string, unknown>).username;
      if (typeof username === 'string') return username;
    }
  }
  return undefined;
}

/**
 * 用完即焚：one_time_password scope 的 key 在 linux.do 配置下是零权限永久凭据，
 * 兑换完成后立即自我吊销（revoke-self 在任何 scope 配置下都被服务端豁免）。
 */
async function revokeKeyQuietly(
  client: DiscourseClient,
  config: LinuxdoConfig,
  apiKey: string,
): Promise<void> {
  try {
    await client.postForm('/user-api-key/revoke', {}, { 'User-Api-Key': apiKey });
  } catch {
    // 吊销失败不影响登录结果；key 留在站方 Apps 列表可手动移除
  }
}

function throwChallengeOrApi(status: number, text: string, path: string): never {
  const challengeMarkers = ['Just a moment', 'challenge-platform', 'Attention Required'];
  if (challengeMarkers.some((m) => text.includes(m))) throw new ChallengeError(status);
  throw new ApiError(status, path, text.slice(0, 200));
}
