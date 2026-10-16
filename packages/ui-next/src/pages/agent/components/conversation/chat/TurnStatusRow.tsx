import { i18n } from '@/i18n';
import { StateDot } from '../../primitives/StateDot';
import type { ChatMessage } from '../../types';
import css from './MessageItem.module.css';

export function TurnStatusRow({ message }: { message: ChatMessage }) {
    const maxTokens = message.eventType === 'turn/max-tokens';
    return <div className={css.turnErrorRow} role="status">
        <StateDot state={maxTokens ? 'warning' : 'error'} className={css.turnErrorDot} />
        <div className={css.turnErrorCopy}>
            <span className={maxTokens ? css.maxTokensTitle : css.turnErrorTitle}>{maxTokens ? i18n('Output limit reached') : i18n('This turn failed')}</span>
            {message.text && <span className={css.turnErrorMessage}>{message.text}</span>}
        </div>
    </div>;
}
