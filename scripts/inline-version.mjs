/**
 * 构建后处理：把 dsh-llm 遗留的运行时 package.json 版本读取
 * 内联为字面量，消除 bundle 对外部文件的最后一点依赖。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const file = 'lib/index.js';
let code = readFileSync(file, 'utf8');

const pattern = /var \{ version \} = createRequire\(import\.meta\.url\)\("\.\.\/package\.json"\);/;
if (pattern.test(code)) {
  code = code.replace(pattern, `var { version } = { version: ${JSON.stringify(pkg.version)} };`);
  writeFileSync(file, code);
  console.log(`[inline-version] 已内联版本 ${pkg.version}`);
} else {
  console.log('[inline-version] 未发现版本读取模式，跳过');
}
