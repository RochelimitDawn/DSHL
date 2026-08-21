import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, foldQuotes, htmlToText, truncateText } from './html.js';
test('命名实体与数字实体解码', () => {
    assert.equal(decodeEntities('&amp; &lt; &gt; &quot; &#39;'), `& < > " '`);
    assert.equal(decodeEntities('&nbsp;x'), ' x');
    assert.equal(decodeEntities('&#20013;&#25991;'), '中文');
    assert.equal(decodeEntities('&#x4e2d;&#x6587;'), '中文');
    assert.equal(decodeEntities('&hellip;&mdash;'), '…—');
    assert.equal(decodeEntities('&unknown;'), '&unknown;');
});
test('pre/code 块转为围栏代码', () => {
    const html = '<p>前文</p><pre><code class="lang-js">const a = 1;\nif (a &lt; 2) {}</code></pre><p>后文</p>';
    const text = htmlToText(html);
    assert.match(text, /```/);
    assert.match(text, /const a = 1;/);
    assert.match(text, /if \(a < 2\) \{\}/);
    assert.match(text, /前文/);
    assert.match(text, /后文/);
});
test('blockquote 多行逐行加引用前缀', () => {
    const html = '<blockquote><p>第一行</p><p>第二行</p></blockquote>';
    const text = htmlToText(html);
    assert.match(text, /> 第一行\n> 第二行/);
});
test('img 转为 [图片:alt](src)，a 链接展开 URL', () => {
    const html = '<p><img src="https://x.y/a.png" alt="示例"><a href="https://linux.do/t/1">话题标题</a></p>';
    const text = htmlToText(html);
    assert.match(text, /\[图片:示例\]\(https:\/\/x\.y\/a\.png\)/);
    assert.match(text, /话题标题 \(https:\/\/linux\.do\/t\/1\)/);
});
test('script/style 内容剔除', () => {
    const html = '<p>正文</p><script>alert(1)</script><style>.x{}</style>';
    const text = htmlToText(html);
    assert.equal(text, '正文');
});
test('Discourse 引用块折叠为单行摘要', () => {
    const html = [
        '<p>看这个：</p>',
        '<aside class="quote no-group" data-username="alice" data-post="2">',
        '<div class="title">alice:</div>',
        '<blockquote><p>这是一段很长的引用原文，包含很多细节。</p></blockquote>',
        '</aside>',
        '<p>我的看法是……</p>',
    ].join('');
    const folded = foldQuotes(html);
    assert.match(folded, /\[引用 @alice #2: 这是一段很长的引用原文[^\]]*\]/);
    // 折叠后不再残留 aside/blockquote 标记
    assert.doesNotMatch(folded, /<aside|<blockquote/i);
    const text = htmlToText(html);
    assert.match(text, /我的看法是/);
    assert.doesNotMatch(text, /<aside/i);
});
test('引用超长时截断加省略号', () => {
    const longText = '长'.repeat(200);
    const html = `<aside class="quote" data-username="u" data-post="1"><blockquote><p>${longText}</p></blockquote></aside>`;
    const folded = foldQuotes(html);
    assert.match(folded, /…\]/);
    assert.ok(folded.length < 200);
});
test('truncateText 不切断代理对（emoji）', () => {
    const text = '中文'.repeat(100) + '😀'.repeat(50);
    const { text: clipped, truncated } = truncateText(text, 210);
    assert.equal(truncated, true);
    // 末尾不应出现孤立代理对（用 TextEncoder 验证可正常编码）
    void new TextEncoder().encode(clipped);
    assert.ok(clipped.length >= 200);
});
test('truncateText 未超限时原样返回', () => {
    const { text, truncated } = truncateText('短文本', 100);
    assert.equal(truncated, false);
    assert.equal(text, '短文本');
});
