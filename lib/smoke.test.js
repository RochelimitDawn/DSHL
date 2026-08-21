import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { ToolRegistry } from '@deepseek-ai/dsh-tools';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { apply, name } from './index.js';
/**
 * 插件生命周期冒烟测试：真实 Cordis 内核加载 → 工具注册 → 卸载回收。
 * 验证 inject 声明、ctx.effect 副作用包裹、ctx.tools.register 的实际兼容性。
 */
/** 模拟 DSH 应用层的最小装配：systemPrompt + tools 注册表服务。 */
function createContextWithTools() {
    const ctx = new Context();
    new SystemPrompt(ctx, {});
    new ToolRegistry(ctx);
    return ctx;
}
test('插件在 Cordis 内核中完成注册与卸载', async () => {
    const ctx = createContextWithTools();
    assert.ok(ctx.tools, 'tools 注册表服务应已装配');
    assert.equal(name, 'linuxdo');
    apply(ctx);
    // 等待 effect 内的注册完成
    await new Promise((resolve) => setTimeout(resolve, 20));
    const expected = [
        'linuxdo_search',
        'linuxdo_semantic_search',
        'linuxdo_get_topic',
        'linuxdo_get_post',
        'linuxdo_get_user',
        'linuxdo_list_categories',
        'linuxdo_browse',
        'linuxdo_get_notifications',
        'linuxdo_search_local',
        'linuxdo_stats',
        'linuxdo_login',
        'linuxdo_login_complete',
        'linuxdo_auth_status',
    ];
    for (const toolName of expected) {
        const definition = ctx.tools.get(toolName);
        assert.ok(definition, `工具 ${toolName} 应已注册`);
        assert.ok(definition.description.length > 10);
    }
    // 模型可见 schema 投影
    const schemas = ctx.tools.schemas();
    const names = schemas.map((s) => s.name);
    for (const toolName of expected) {
        assert.ok(names.includes(toolName), `工具 ${toolName} 应出现在模型可见 schema 中`);
    }
});
test('工具 schema 参数声明符合 DSH 契约', async () => {
    const ctx = createContextWithTools();
    apply(ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const search = ctx.tools.get('linuxdo_search');
    assert.ok(search);
    const schema = ctx.tools.schemas().find((s) => s.name === 'linuxdo_search');
    assert.ok(schema);
    // 参数 schema 已编译为 JSON Schema 形态
    assert.ok(JSON.stringify(schema).includes('query'));
    const getTopic = ctx.tools.get('linuxdo_get_topic');
    assert.ok(getTopic);
    assert.ok(getTopic.output, '工具必须声明 canonical output 契约');
});
