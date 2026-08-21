/**
 * 插件配置。
 *
 * 来源优先级（高到低）：
 * 1. cordis.yml 行内 config（经 apply(ctx, config) 第二参数注入）
 * 2. 环境变量 LINUXDO_*
 * 3. 内置默认值
 */
export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const DEFAULT_CONFIG = {
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
function num(value) {
    if (value === undefined || value.trim() === '')
        return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function bool(value) {
    if (value === undefined || value.trim() === '')
        return undefined;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
/**
 * 解析生效的站点列表：sites 为空时由顶层 baseUrl 派生单站点。
 */
export function resolveSites(config) {
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
function safeHost(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return '';
    }
}
/**
 * 合并三层配置来源。inline 来自 cordis.yml 行内 config；
 * 环境变量覆盖默认值；inline 优先级最高。
 */
export function resolveConfig(inline, env = process.env) {
    const fromEnv = {};
    if (env.LINUXDO_BASE_URL)
        fromEnv.baseUrl = env.LINUXDO_BASE_URL;
    if (env.LINUXDO_USER_AGENT)
        fromEnv.userAgent = env.LINUXDO_USER_AGENT;
    const concurrent = num(env.LINUXDO_MAX_CONCURRENT);
    if (concurrent !== undefined)
        fromEnv.maxConcurrent = Math.max(1, Math.floor(concurrent));
    const windowMax = num(env.LINUXDO_WINDOW_MAX);
    if (windowMax !== undefined)
        fromEnv.windowMax = Math.floor(windowMax);
    const windowSeconds = num(env.LINUXDO_WINDOW_SECONDS);
    if (windowSeconds !== undefined)
        fromEnv.windowSeconds = Math.floor(windowSeconds);
    const maxChars = num(env.LINUXDO_MAX_OUTPUT_CHARS);
    if (maxChars !== undefined)
        fromEnv.maxOutputChars = Math.floor(maxChars);
    if (env.LINUXDO_SESSION_FILE)
        fromEnv.sessionFile = env.LINUXDO_SESSION_FILE;
    if (env.LINUXDO_CURL_IMPERSONATE)
        fromEnv.curlImpersonatePath = env.LINUXDO_CURL_IMPERSONATE;
    const localIndex = bool(env.LINUXDO_LOCAL_INDEX);
    if (localIndex !== undefined)
        fromEnv.localIndexEnabled = localIndex;
    return {
        ...DEFAULT_CONFIG,
        ...fromEnv,
        ...(inline ?? {}),
    };
}
