import { PluginCard } from './PluginCard';
import { SecretField, ValueField } from './PluginFields';
import { numberField, textField, useCardForm, type SettingsRpc } from './cardForm';

const DEFAULT_API_KEY_REF = 'DEEPSEEK_API_KEY';

function refOf(view: { apiKeyEnv?: string } | undefined): string {
    return view?.apiKeyEnv ?? DEFAULT_API_KEY_REF;
}

export function BashCard({ rpc }: { rpc: SettingsRpc }) {
    const form = useCardForm({ rpc, ns: 'shell', fields: [numberField('timeoutMs'), numberField('maxOutputBytes')] });
    const disabled = !form.state.writable;
    const timeoutMs = form.fieldState('timeoutMs');
    const maxOutputBytes = form.fieldState('maxOutputBytes');
    return (
        <PluginCard title="终端" description="限制 agent 运行的每一条命令。" state={form.state} onSave={form.save} onDiscard={form.discard}>
            <ValueField
                id="plugin-config-bash-timeout"
                label="命令超时（毫秒）"
                hint="单条命令允许运行多久，超时即终止。"
                overriddenLabel="已覆盖"
                resetLabel="恢复默认"
                invalidLabel="请填数字；留空表示使用默认值。"
                numeric
                disabled={disabled}
                text={timeoutMs.text}
                overridden={timeoutMs.overridden}
                invalid={timeoutMs.invalid}
                onEdit={(text) => { form.edit('timeoutMs', text); }}
                onReset={() => { form.resetField('timeoutMs'); }}
            />
            <ValueField
                id="plugin-config-bash-output"
                label="单流输出上限（字节）"
                hint="超出部分会转存到临时文件，而不是被丢弃。"
                overriddenLabel="已覆盖"
                resetLabel="恢复默认"
                invalidLabel="请填数字；留空表示使用默认值。"
                numeric
                disabled={disabled}
                text={maxOutputBytes.text}
                overridden={maxOutputBytes.overridden}
                invalid={maxOutputBytes.invalid}
                onEdit={(text) => { form.edit('maxOutputBytes', text); }}
                onReset={() => { form.resetField('maxOutputBytes'); }}
            />
        </PluginCard>
    );
}

export function AgentLoopCard({ rpc }: { rpc: SettingsRpc }) {
    const form = useCardForm({ rpc, ns: 'agent-loop', fields: [numberField('maxParallelToolCalls')] });
    const maxParallel = form.fieldState('maxParallelToolCalls');
    return (
        <PluginCard title="Agent 循环" description="Agent 如何派发工具调用。" state={form.state} onSave={form.save} onDiscard={form.discard}>
            <ValueField
                id="plugin-config-agent-loop-parallel"
                label="并行工具调用数"
                hint="同一步内最多同时运行多少个可并行的调用。"
                overriddenLabel="已覆盖"
                resetLabel="恢复默认"
                invalidLabel="请填数字；留空表示使用默认值。"
                numeric
                disabled={!form.state.writable}
                text={maxParallel.text}
                overridden={maxParallel.overridden}
                invalid={maxParallel.invalid}
                onEdit={(text) => { form.edit('maxParallelToolCalls', text); }}
                onReset={() => { form.resetField('maxParallelToolCalls'); }}
            />
        </PluginCard>
    );
}

export function WebSearchCard({ rpc }: { rpc: SettingsRpc }) {
    const form = useCardForm({
        rpc,
        ns: 'web-search-deepseek',
        fields: [textField('baseURL'), numberField('maxUses')],
        secret: { field: 'apiKey', ref: (view) => refOf(asWebSearchValue(view)) },
    });
    const disabled = !form.state.writable;
    const baseURL = form.fieldState('baseURL');
    const maxUses = form.fieldState('maxUses');
    return (
        <PluginCard title="网页搜索" description="DeepSeek 搜索提供方。" state={form.state} onSave={form.save} onDiscard={form.discard}>
            <SecretField
                id="plugin-config-web-search-key"
                label="API Key"
                hint="不写入设置文件。留空表示保持当前密钥。"
                text={form.state.secretText}
                configured={form.state.secretConfigured}
                stateLabel={form.state.secretConfigured ? '已配置密钥。' : '未配置密钥；配置之前搜索不可用。'}
                disabled={!form.state.secretWritable}
                onEdit={form.editSecret}
            />
            <ValueField
                id="plugin-config-web-search-endpoint"
                label="接口地址"
                hint="留空则使用提供方默认地址。"
                overriddenLabel="已覆盖"
                resetLabel="恢复默认"
                invalidLabel="请填数字；留空表示使用默认值。"
                disabled={disabled}
                text={baseURL.text}
                overridden={baseURL.overridden}
                invalid={baseURL.invalid}
                onEdit={(text) => { form.edit('baseURL', text); }}
                onReset={() => { form.resetField('baseURL'); }}
            />
            <ValueField
                id="plugin-config-web-search-max-uses"
                label="单次请求最多搜索次数"
                hint="一次请求在必须作答前最多可以搜索多少次。"
                overriddenLabel="已覆盖"
                resetLabel="恢复默认"
                invalidLabel="请填数字；留空表示使用默认值。"
                numeric
                disabled={disabled}
                text={maxUses.text}
                overridden={maxUses.overridden}
                invalid={maxUses.invalid}
                onEdit={(text) => { form.edit('maxUses', text); }}
                onReset={() => { form.resetField('maxUses'); }}
            />
        </PluginCard>
    );
}

function asWebSearchValue(view: unknown): { apiKeyEnv?: string } | undefined {
    if (!view || typeof view !== 'object') return undefined;
    const value = (view as { value?: unknown }).value;
    if (!value || typeof value !== 'object') return undefined;
    return value as { apiKeyEnv?: string };
}
