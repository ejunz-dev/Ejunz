import type { ChatMessage } from '../types';
import { toolRowModel } from './tool-call-model';
import { ToolViewCard } from './toolviews/ToolViewCard';

export function ToolDetails({ message }: { message: ChatMessage }) {
    const model = toolRowModel(message);
    return <div className="eja-toolDetails">
        <ToolViewCard variant={model.variant} input={model.input} output={model.output} meta={model.meta} error={model.state === 'error'} />
    </div>;
}
