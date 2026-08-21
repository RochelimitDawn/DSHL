/**
 * 插件配置。
 *
 * 来源优先级（高到低）：
 * 1. cordis.yml 行内 config（经 apply(ctx, config) 第二参数注入）
 * 2. 环境变量 LINUXDO_*
 * 3. 内置默认值
 */

/** 多站点 Profile：每个条目对应一个 Discourse 实例。 */
export interface SiteProfile {
  /** 站点标识：工具 site 参数与本地索引隔离键 */
  name: string;
  baseUrl: string;
  /** 该站点的会话文件路径；缺省派生自主目录 */
  sessionFile?: string;
  /** 该站点专属 UA；缺省用全局 userAgent */
  userAgent?: string;
}

export interface LinuxdoConfig {
  /** Discourse 站点根地址，默认 https://linux.do，可指向任意 Discourse 实例 */
  baseUrl: string;
  /** 请求 UA。与导出 cookie 的浏览器保持一致可显著降低 CF 拦截概率 */
  userAgent: string;
  /** 最大并发请求数（每站点独立生效） */
  maxConcurrent: number;
  /** 滑动窗口内最大请求数 */
  windowMax: number;
  /** 滑动窗口时长（秒） */
  windowSeconds: number;
  /** 话题/帖子内容缓存 TTL（毫秒） */
  topicCacheTtlMs: number;
  /** 搜索结果缓存 TTL（毫秒） */
  searchCacheTtlMs: number;
  /** 单次工具输出的最大字符数（token 控制硬上限） */
  maxOutputChars: number;
  /** 会话文件路径（存 _t），默认 ~/.dsh-plugin-linuxdo/session.json */
  sessionFile: string;
  /** 本地授权回调监听地址 */
  callbackHost: string;
  /** 本地授权回调端口，0 = 随机可用端口 */
  callbackPort: number;
  /** 授权回调 server 存活时长（毫秒） */
  callbackTimeoutMs: number;
  /**
   * curl-impersonate 二进制路径（如 chrome 版）。
   * 配置后遇到 Cloudflare 挑战页自动切换 Chrome TLS 指纹重试；
   * 未配置时维持原生 fetch 直连。
   */
  curlImpersonatePath: string;
  /** 是否启用本地 FTS5 知识库沉淀（读过的话题自动入库供离线检索） */
  localIndexEnabled: boolean;
  /** 多站点 Profile；为空时仅启用顶层 baseUrl 的默认站点 */
  sites: SiteProfile[];
}

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const DEFAULT_CONFIG: LinuxdoConfig = {
  baseUrl: 'https://linux.do',
  userAgent: DEFAULT_USER_AGENT,
  maxConcurrent: 2,
  windowMax: 4,
  windowSeconds: 3,
  topicCacheTtlMs: 10 * 60 * 1000,
  searchCacheTtlMs: 60 * 1000,
  maxOutputChars: 8000,
  sessionFile: '',
  callbackHost: '127.0.0.1',
  callbackPort: 0,
  callbackTimeoutMs: 10 * 60 * 1000,
  curlImpersonatePath: '',
  localIndexEnabled: true,
  sites: [],
};

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * 解析生效的站点列表：sites 为空时由顶层 baseUrl 派生单站点。
 */
export function resolveSites(config: LinuxdoConfig): SiteProfile[] {
  if (config.sites.length > 0) {
    return config.sites.map((site, i) => ({
      ...site,
      name: site.name || `site-${i}`,
    }));
  }
  const host = safeHost(config.baseUrl);
  return [
    {
      name: host || 'default',
      baseUrl: config.baseUrl,
      sessionFile: config.sessionFile || undefined,
    },
  ];
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * 合并三层配置来源。inline 来自 cordis.yml 行内 config；
 * 环境变量覆盖默认值；inline 优先级最高。
 */
export function resolveConfig(
  inline: Partial<LinuxdoConfig> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): LinuxdoConfig {
  const fromEnv: Partial<LinuxdoConfig> = {};
  if (env.LINUXDO_BASE_URL) fromEnv.baseUrl = env.LINUXDO_BASE_URL;
  if (env.LINUXDO_USER_AGENT) fromEnv.userAgent = env.LINUXDO_USER_AGENT;
  const concurrent = num(env.LINUXDO_MAX_CONCURRENT);
  if (concurrent !== undefined) fromEnv.maxConcurrent = Math.max(1, Math.floor(concurrent));
  const windowMax = num(env.LINUXDO_WINDOW_MAX);
  if (windowMax !== undefined) fromEnv.windowMax = Math.floor(windowMax);
  const windowSeconds = num(env.LINUXDO_WINDOW_SECONDS);
  if (windowSeconds !== undefined) fromEnv.windowSeconds = Math.floor(windowSeconds);
  const maxChars = num(env.LINUXDO_MAX_OUTPUT_CHARS);
  if (maxChars !== undefined) fromEnv.maxOutputChars = Math.floor(maxChars);
  if (env.LINUXDO_SESSION_FILE) fromEnv.sessionFile = env.LINUXDO_SESSION_FILE;
  if (env.LINUXDO_CURL_IMPERSONATE) fromEnv.curlImpersonatePath = env.LINUXDO_CURL_IMPERSONATE;
  const localIndex = bool(env.LINUXDO_LOCAL_INDEX);
  if (localIndex !== undefined) fromEnv.localIndexEnabled = localIndex;

  return {
    ...DEFAULT_CONFIG,
    ...fromEnv,
    ...(inline ?? {}),
  };
}
