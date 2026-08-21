import { TtlCache, type CacheStats } from './cache.js';
import { RateLimiter, type LimiterStats } from './limiter.js';
import {
  FetchTransport,
  CurlImpersonateTransport,
  type Transport,
} from './transport.js';
import { ApiError, AuthRequiredError, ChallengeError, looksLikeChallenge } from './errors.js';
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
export class DiscourseClient {
  private readonly limiter: RateLimiter;
  private readonly cache: TtlCache<unknown>;
  private transport: Transport;
  private readonly impersonate?: CurlImpersonateTransport;
  private totalRequests = 0;
  private challenges = 0;
  private impersonateFallbacks = 0;
  private sessionInvalidated = false;

  constructor(
    private readonly config: LinuxdoConfig,
    private readonly session: SessionStore,
    fetchImpl: Transport | typeof fetch = fetch,
  ) {
    this.limiter = new RateLimiter({
      maxConcurrent: config.maxConcurrent,
      windowMax: config.windowMax,
      windowSeconds: config.windowSeconds,
    });
    this.cache = new TtlCache(Math.max(config.topicCacheTtlMs, config.searchCacheTtlMs));
    if (typeof fetchImpl === 'function') {
      this.transport = new FetchTransport(fetchImpl);
    } else {
      this.transport = fetchImpl;
    }
    if (config.curlImpersonatePath.trim() !== '') {
      this.impersonate = new CurlImpersonateTransport(config.curlImpersonatePath.trim());
    }
  }

  get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '');
  }

  /** 是否持有有效登录态（含失效标记判断）。 */
  hasSession(): boolean {
    return Boolean(this.session.load().tToken) && !this.sessionInvalidated;
  }

  stats(): ClientStats {
    return {
      totalRequests: this.totalRequests,
      cacheHits: this.cache.stats().hits,
      challenges: this.challenges,
      impersonateFallbacks: this.impersonateFallbacks,
      activeTransport: this.transport.name,
      sessionInvalidated: this.sessionInvalidated,
      limiter: this.limiter.stats(),
      cache: this.cache.stats(),
    };
  }

  private buildUrl(path: string, query?: GetOptions['query']): string {
    const url = new URL(path, `${this.baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** 浏览器形态的基础请求头（不含登录态）。 */
  private baseHeaders(): Record<string, string> {
    return {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': this.config.userAgent,
    };
  }

  private authHeaders(): Record<string, string> {
    const headers = this.baseHeaders();
    const { tToken } = this.session.load();
    if (tToken) headers.Cookie = `_t=${tToken}`;
    return headers;
  }

  /** 发起 GET 请求并解析 JSON 响应。 */
  async getJson<T = unknown>(path: string, options: GetOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const ttl = options.cacheTtlMs ?? this.config.topicCacheTtlMs;
    if (ttl > 0) {
      const cached = this.cache.get(url);
      if (cached !== undefined) return cached as T;
    }
    const data = await this.limiter.run(
      () => this.requestJson<T>(url, options.signal),
      options.signal,
    );
    if (ttl > 0) this.cache.set(url, data);
    return data;
  }

  /** 绕过缓存直接请求（登录流程等敏感路径使用）。 */
  async postForm(
    path: string,
    body: Record<string, string>,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<{ status: number; json: unknown; text: string; setCookies: string[] }> {
    const merged = { ...this.baseHeaders(), ...headers };
    return this.limiter.run(
      () => this.requestRaw('POST', this.buildUrl(path), body, merged, signal),
      signal,
    );
  }

  private async requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const { status, json, text, setCookies } = await this.requestRaw(
      'GET',
      url,
      undefined,
      this.authHeaders(),
      signal,
    );
    this.absorbCookies(setCookies);
    if (status === 200) {
      return json as T;
    }
    this.throwForStatus(status, url, text);
  }

  private async requestRaw(
    method: 'GET' | 'POST',
    url: string,
    formBody: Record<string, string> | undefined,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ status: number; json: unknown; text: string; setCookies: string[] }> {
    this.totalRequests += 1;
    const body = formBody ? new URLSearchParams(formBody).toString() : undefined;
    let response = await this.transport.request({
      method,
      url,
      headers: {
        ...headers,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
      },
      body,
      signal,
    });

    // 挑战页降级链：配置了 impersonate 且当前走 fetch 时，切换指纹通道重试一次
    if (this.isChallenge(response) && this.impersonate && this.transport !== this.impersonate) {
      this.challenges += 1;
      this.impersonateFallbacks += 1;
      response = await this.impersonate.request({
        method,
        url,
        headers: {
          ...headers,
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
        },
        body,
        signal,
      });
      // sticky：指纹通道可用后保持使用，避免反复撞盾
      if (!this.isChallenge(response)) {
        this.transport = this.impersonate;
      }
    }

    let json: unknown = null;
    try {
      json = response.text ? JSON.parse(response.text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text: response.text, setCookies: response.setCookies };
  }

  private isChallenge(response: { status: number; text: string }): boolean {
    return response.status === 403 && looksLikeChallenge(response.text);
  }

  private throwForStatus(status: number, url: string, text: string): never {
    if (looksLikeChallenge(text)) {
      this.challenges += 1;
      throw new ChallengeError(status);
    }
    if (status === 401 || status === 403) {
      // 标记会话失效，auth_status 可据此提前预警
      this.sessionInvalidated = true;
      throw new AuthRequiredError(`HTTP ${status} ${url}`);
    }
    if (status === 429) {
      throw new ApiError(status, url, '触发站点限流，请稍后重试');
    }
    let detail = text.slice(0, 200);
    if (detail.startsWith('{')) {
      try {
        const parsed = JSON.parse(text) as { errors?: unknown };
        if (Array.isArray(parsed.errors)) detail = parsed.errors.join('; ');
      } catch {
        // 保留原始截断文本
      }
    }
    throw new ApiError(status, url, detail);
  }

  /** Discourse 会在响应中滚动续期 _t，捕获并回写。 */
  private absorbCookies(setCookies: string[]): void {
    for (const cookie of setCookies) {
      const match = /(?:^|;\s*)_t=([^;]+)/.exec(cookie);
      if (match && match[1] && match[1] !== this.session.load().tToken) {
        this.session.save({ ...this.session.load(), tToken: match[1] });
      }
    }
  }

  /** 手动写入登录态（OTP 兑换成功后调用）。 */
  adoptToken(tToken: string, username?: string): void {
    this.session.save({ ...this.session.load(), tToken, ...(username ? { username } : {}) });
    this.sessionInvalidated = false;
    this.cache.clear();
  }
}
