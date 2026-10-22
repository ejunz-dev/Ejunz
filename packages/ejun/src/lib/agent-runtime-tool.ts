export interface AgentRuntimeToolCall {
    type: 'ejunz/runtime-tool-call';
    toolName: string;
}

/** Ask the Agent tool-host adapter to run the same-named native tool with the original arguments. */
export function delegateAgentRuntimeTool(toolName: string): AgentRuntimeToolCall {
    return {
        type: 'ejunz/runtime-tool-call',
        toolName,
    };
}
