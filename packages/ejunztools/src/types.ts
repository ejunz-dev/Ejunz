/**
 * Tool contracts, declared once in core and shared with every implementation here.
 *
 * The registry (`ejun/src/service/tools.ts`) is the seam these describe, so core owns
 * them; this barrel keeps the implementations' `../types` imports pointing at one file.
 */
export type {
    SystemToolExecutionContext,
    ToolArgs,
    ToolCalledPayload,
    ToolContext,
    ToolSpec,
} from 'ejun/src/tool/types';
