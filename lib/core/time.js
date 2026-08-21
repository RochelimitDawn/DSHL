/** 相对时间与 Discourse UTC 时间展示辅助。 */
/**
 * ISO 时间戳 → 人性化相对时间。
 * 超过 12 个月退化为具体日期，避免"3 年前"式模糊。
 */
export function relativeTime(iso, now = Date.now()) {
    if (!iso)
        return '';
    const then = Date.parse(iso);
    if (!Number.isFinite(then))
        return iso;
    const diffMs = now - then;
    if (diffMs < 0)
        return '刚刚';
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diffMs < minute)
        return '刚刚';
    if (diffMs < hour)
        return `${Math.floor(diffMs / minute)} 分钟前`;
    if (diffMs < day)
        return `${Math.floor(diffMs / hour)} 小时前`;
    if (diffMs < 30 * day)
        return `${Math.floor(diffMs / day)} 天前`;
    const months = Math.floor(diffMs / (30 * day));
    if (months < 12)
        return `${months} 个月前`;
    const d = new Date(then);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** 构造话题楼层深链（Discourse 标准 URL 形态）。 */
export function topicPermalink(baseUrl, slug, topicId, postNumber) {
    const base = baseUrl.replace(/\/+$/, '');
    const slugPart = slug && slug !== '' ? slug : 'topic';
    return postNumber !== undefined && postNumber > 0
        ? `${base}/t/${slugPart}/${topicId}/${postNumber}`
        : `${base}/t/${slugPart}/${topicId}`;
}
