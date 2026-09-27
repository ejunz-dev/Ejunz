import { useState } from 'react';
import type { PendingQuestion } from '../types';

interface QuestionPanelProps {
    question: PendingQuestion;
    onAnswer: (answer: { answers: { id: string; selected: string[]; custom?: string }[] }) => Promise<void>;
}

export function QuestionPanel({ question, onAnswer }: QuestionPanelProps) {
    const [selected, setSelected] = useState<Record<string, string[]>>({});
    const [busy, setBusy] = useState(false);
    const answer = async () => {
        setBusy(true);
        try {
            await onAnswer({ answers: question.questions.map((item) => ({ id: item.id, selected: selected[item.id] ?? [] })) });
        } finally {
            setBusy(false);
        }
    };
    return <div className="eja-questionPanel">
        <div className="eja-questionTitle">需要你的回答</div>
        {question.questions.map((item) => <fieldset key={item.id} className="eja-questionItem">
            <legend>{item.header || item.question || item.id}</legend>
            {(item.options ?? []).map((option) => {
                const label = option.label ?? '';
                const checked = selected[item.id]?.includes(label) === true;
                return <label key={label} className="eja-questionOption"><input type={item.multiSelect ? 'checkbox' : 'radio'} name={item.id} checked={checked} onChange={() => setSelected((value) => ({ ...value, [item.id]: item.multiSelect ? checked ? (value[item.id] ?? []).filter((entry) => entry !== label) : [...value[item.id] ?? [], label] : [label] }))} /><span>{label}</span>{option.description && <small>{option.description}</small>}</label>;
            })}
        </fieldset>)}
        <button type="button" className="eja-questionSubmit" disabled={busy} onClick={() => void answer()}>提交回答</button>
    </div>;
}
