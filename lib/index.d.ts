import type { Context } from '@deepseek-ai/cordis';
import { type LinuxdoConfig } from './config.js';
export declare const name = "linuxdo";
/** 依赖 tools 注册表与系统提示服务就绪后再挂载。 */
export declare const inject: string[];
/**
 * 插件入口。
 *
 * @param ctx Cordis 上下文；所有注册经 ctx.effect 包裹，插件卸载时自动回收
 * @param inlineConfig cordis.yml 行内 config（可选）
 */
export declare function apply(ctx: Context, inlineConfig?: Partial<LinuxdoConfig>): void;
export default apply;
