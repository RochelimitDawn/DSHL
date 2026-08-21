/**
 * Discourse cooked HTML → 纯文本清洗器。
 *
 * 目标是 token 效率：保留语义结构（代码块、引用、链接、图片），
 * 剥离全部标记噪声，输出可直接进入 LLM 上下文的紧凑文本。
 */
const NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    laquo: '«',
    raquo: '»',
    ldquo: '\u201C',
    rdquo: '\u201D',
    lsquo: '\u2018',
    rsquo: '\u2019',
    copy: '©',
    reg: '®',
    trade: '™',
    times: '×',
    middot: '·',
};
export function decodeEntities(input) {
    return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
        if (body.startsWith('#x') || body.startsWith('#X')) {
            const code = parseInt(body.slice(2), 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        if (body.startsWith('#')) {
            const code = parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    });
}
/** 提取 pre/code 块为占位符，避免内部标签被后续步骤破坏。 */
function extractCodeBlocks(html) {
    const blocks = [];
    const stripped = html.replace(/<pre>(?:\s*<code[^>]*>)?([\s\S]*?)(?:<\/code>\s*)?<\/pre>/gi, (_match, inner) => {
        const index = blocks.length;
        blocks.push({ token: `\u0000CODE${index}\u0000`, text: inner });
        return `\u0000CODE${index}\u0000`;
    });
    return { stripped, blocks };
}
function decodeCodeBlock(inner) {
    const withoutTags = inner.replace(/<[^>]+>/g, '');
    const decoded = decodeEntities(withoutTags);
    // 去掉每行行尾空白，压缩 3 个以上连续空行
    const lines = decoded
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/\s+$/, ''));
    while (lines.length > 0 && lines[0] === '')
        lines.shift();
    while (lines.length > 0 && lines[lines.length - 1] === '')
        lines.pop();
    return lines.join('\n');
}
/** 单行内联清洗：剥标签、转链接/图片、解码实体、压缩空白。 */
function inlineToText(html) {
    let text = html;
    text = text.replace(/<img\s[^>]*>/gi, (tag) => {
        const src = /(?:\bsrc|data-large-src)="([^"]+)"/i.exec(tag)?.[1] ?? '';
        const alt = /\balt="([^"]*)"/i.exec(tag)?.[1] ?? '图片';
        return src ? `[图片:${decodeEntities(alt)}](${src})` : `[图片:${decodeEntities(alt)}]`;
    });
    text = text.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
        const label = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
        const url = decodeEntities(href);
        if (!label)
            return url;
        // 站内相对链接与纯锚点不做冗余展开
        if (url === label || url.startsWith('#'))
            return label;
        return `${label} (${url})`;
    });
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');
    text = decodeEntities(text);
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/ ?\n ?/g, '\n');
    return text.trim();
}
/**
 * 主入口：把 cooked HTML 转成紧凑纯文本。
 */
export function htmlToText(html) {
    if (!html)
        return '';
    let text = html;
    // 1. 剔除不可见块
    text = text.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '');
    // 2. 提取代码块
    const { stripped, blocks } = extractCodeBlocks(text);
    text = stripped;
    // 3. Discourse 引用块折叠为单行摘要（aside.quote 结构）
    text = foldQuotes(text);
    // 4. 块级结构转换
    text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) => {
        const innerText = inner
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div)>/gi, '\n')
            .replace(/<[^>]+>/g, '');
        const lines = decodeEntities(innerText)
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => `> ${line}`);
        return `\n${lines.join('\n')}\n`;
    });
    text = text.replace(/<h([1-6])[^>]*>/gi, '\n\n').replace(/<\/h[1-6]>/gi, '\n');
    text = text.replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '');
    text = text.replace(/<\/(p|div|ul|ol|table|tr|section|article|aside|header|footer)>/gi, '\n');
    text = text.replace(/<(p|div|ul|ol|table|section|article|aside|header|footer)[^>]*>/gi, '\n');
    text = text.replace(/<\/?(td|th)[^>]*>/gi, ' ');
    text = text.replace(/<hr\s*\/?>/gi, '\n---\n');
    // 5. 剩余内联清洗
    text = inlineToText(text);
    // 6. 回填代码块
    for (const block of blocks) {
        const code = decodeCodeBlock(block.text);
        const fence = '```';
        text = text.replace(block.token, `\n${fence}\n${code}\n${fence}\n`);
    }
    // 7. 压缩空白
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.replace(/^\n+|\n+$/g, '');
    return text;
}
const QUOTE_SUMMARY_MAX_CHARS = 80;
/**
 * 折叠 Discourse 引用块：
 * <aside class="quote" data-username="x" data-post="N">…<blockquote>原文</blockquote></aside>
 * → [引用 @x #N: 首行摘要…]
 * 引用全文与被引内容高度重复，完整保留只会浪费 token。
 */
export function foldQuotes(html) {
    return html.replace(/<aside\s+class="quote[^"]*"[^>]*>([\s\S]*?)<\/aside>/gi, (match, inner) => {
        const username = /\bdata-username="([^"]*)"/i.exec(match)?.[1] ?? '';
        const postNumber = /\bdata-post="([^"]*)"/i.exec(match)?.[1] ?? '';
        const quoteBody = inner
            .replace(/<div class="title">[\s\S]*?<\/div>/i, '')
            .replace(/<blockquote[^>]*>|<\/blockquote>/gi, '')
            .replace(/<[^>]+>/g, ' ');
        const summary = decodeEntities(quoteBody)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, QUOTE_SUMMARY_MAX_CHARS);
        const ellipsis = summary.length >= QUOTE_SUMMARY_MAX_CHARS ? '…' : '';
        const parts = [
            username ? `@${username}` : '',
            postNumber ? `#${postNumber}` : '',
        ].filter(Boolean);
        return `\n[引用${parts.length > 0 ? ` ${parts.join(' ')}` : ''}: ${summary}${ellipsis}]\n`;
    });
}
/**
 * 截断到 maxChars 并保证不切断多字节代理对。
 * 返回截断后的文本与是否发生截断。
 */
export function truncateText(text, maxChars) {
    if (text.length <= maxChars)
        return { text, truncated: false };
    // 用 Array.from 避免切断代理对（emoji 等）
    const chars = Array.from(text);
    if (chars.length <= maxChars)
        return { text, truncated: false };
    return { text: chars.slice(0, maxChars).join(''), truncated: true };
}
