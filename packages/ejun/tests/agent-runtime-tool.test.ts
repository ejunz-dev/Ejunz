import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delegateAgentRuntimeTool } from '../src/lib/agent-runtime-tool';

test('delegates host tool execution to the same Agent runtime tool', () => {
    assert.deepEqual(delegateAgentRuntimeTool('web_search'), {
        type: 'ejunz/runtime-tool-call',
        toolName: 'web_search',
    });
});
