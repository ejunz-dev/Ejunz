import { i18n } from '@/i18n';
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
        <PluginCard title={i18n('Terminal')} description={i18n('Limit every command the agent runs.')} state={form.state} onSave={form.save} onDiscard={form.discard}>
            <ValueField
                id="plugin-config-bash-timeout"
                label={i18n('Command timeout (ms)')}
                hint={i18n('How long a single command may run before it is stopped.')}
                overriddenLabel={i18n('Overridden')}
                resetLabel={i18n('Restore default')}
                invalidLabel={i18n('Enter a number, or leave blank to use the default.')}
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
                label={i18n('Per-stream output limit (bytes)')}
                hint={i18n('Output beyond the limit is stored in a temporary file instead of being discarded.')}
                overriddenLabel={i18n('Overridden')}
                resetLabel={i18n('Restore default')}
                invalidLabel={i18n('Enter a number, or leave blank to use the default.')}
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
        <PluginCard title={i18n('Agent loop')} description={i18n('How the Agent dispatches tool calls.')} state={form.state} onSave={form.save} onDiscard={form.discard}>
            <ValueField
                id="plugin-config-agent-loop-parallel"
                label={i18n('Parallel tool calls')}
                hint={i18n('How many parallel calls may run at once in the same step.')}
                overriddenLabel={i18n('Overridden')}
                resetLabel={i18n('Restore default')}
                invalidLabel={i18n('Enter a number, or leave blank to use the default.')}
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
        <PluginCard title={i18n('Web search')} description={i18n('DeepSeek search provider.')} state={form.state} onSave={form.save} onDiscard={form.discard}>
            <SecretField
                id="plugin-config-web-search-key"
                label={i18n('API key')}
                hint={i18n('Not written to the settings file. Leave blank to keep the current key.')}
                text={form.state.secretText}
                configured={form.state.secretConfigured}
                stateLabel={form.state.secretConfigured ? i18n('API key configured.') : i18n('No API key configured. Search stays unavailable until one is set.')}
                disabled={!form.state.secretWritable}
                onEdit={form.editSecret}
            />
            <ValueField
                id="plugin-config-web-search-endpoint"
                label={i18n('Endpoint')}
                hint={i18n('Leave blank to use the provider default.')}
                overriddenLabel={i18n('Overridden')}
                resetLabel={i18n('Restore default')}
                invalidLabel={i18n('Enter a number, or leave blank to use the default.')}
                disabled={disabled}
                text={baseURL.text}
                overridden={baseURL.overridden}
                invalid={baseURL.invalid}
                onEdit={(text) => { form.edit('baseURL', text); }}
                onReset={() => { form.resetField('baseURL'); }}
            />
            <ValueField
                id="plugin-config-web-search-max-uses"
                label={i18n('Maximum searches per request')}
                hint={i18n('How many searches one request may make before it must answer.')}
                overriddenLabel={i18n('Overridden')}
                resetLabel={i18n('Restore default')}
                invalidLabel={i18n('Enter a number, or leave blank to use the default.')}
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
