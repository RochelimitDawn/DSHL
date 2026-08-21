import { type CacheStats } from './cache.js';
import { type LimiterStats } from './limiter.js';
import { type Transport } from './transport.js';
import type { LinuxdoConfig } from '../config.js';
import type { SessionStore } from '../auth/session-store.js';
export interface GetOptions {
    /** 查询参数；值会被 URL 编码，数组编码为重复键 */
    query?: Record<string, string | number | boolean | undefined>;
    /** 覆盖缓存 TTL（毫秒）；0 表示绕过读缓存 */
    cacheTtlMs?: number;
    signal?: AbortSignal;
}
export interface ClientStats {
    totalRequests: number;
    cacheHits: number;
    challenges: number;
    impersonateFallbacks: number;
    activeTransport: string;
    sessionInvalidated: boolean;
    limiter: LimiterStats;
    cache: CacheStats;
}
/**
 * Discourse 只读 API 客户端。
 *
 * - 统一携带浏览器形态的请求头与登录态 cookie
 * - 所有请求经 RateLimiter 排队
 * - GET 响应进 TTL 缓存
 * - 识别 Cloudflare 挑战页：配置了 curl-impersonate 时自动切换 Chrome
 *   TLS 指纹通道并 sticky 重试；否则抛结构化 ChallengeError
 * - 401/403 标记会话失效（挑战页除外），供 auth_status 预检
 * - 响应中的 Set-Cookie 会滚动续期 _t 并回写会话存储
 */
export declare class DiscourseClient {
    private readonly config;
    private readonly session;
    private readonly limiter;
    private readonly cache;
    private transport;
    private readonly impersonate?;
    private totalRequests;
    private challenges;
    private impersonateFallbacks;
    private sessionInvalidated;
    constructor(config: LinuxdoConfig, session: SessionStore, fetchImpl?: Transport | typeof fetch);
    get baseUrl(): string;
    /** 是否持有有效登录态（含失效标记判断）。 */
    hasSession(): boolean;
    stats(): ClientStats;
    private buildUrl;
    /** 浏览器形态的基础请求头（不含登录态）。 */
    private baseHeaders;
    private authHeaders;
    /** 发起 GET 请求并解析 JSON 响应。 */
    getJson<T = unknown>(path: string, options?: GetOptions): Promise<T>;
    /** 绕过缓存直接请求（登录流程等敏感路径使用）。 */
    postForm(path: string, body: Record<string, string>, headers?: Record<string, string>, signal?: AbortSignal): Promise<{
        status: number;
        json: unknown;
        text: string;
        setCookies: string[];
    }>;
    private requestJson;
    private requestRaw;
    private isChallenge;
    private throwForStatus;
    /** Discourse 会在响应中滚动续期 _t，捕获并回写。 */
    private absorbCookies;
    /** 手动写入登录态（OTP 兑换成功后调用）。 */
    adoptToken(tToken: string, username?: string): void;
}
