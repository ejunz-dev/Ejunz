import css from './PluginFields.module.css';

export interface ValueFieldProps {
    id: string;
    label: string;
    hint: string;
    text: string;
    overridden: boolean;
    invalid: boolean;
    overriddenLabel: string;
    resetLabel: string;
    invalidLabel: string;
    disabled: boolean;
    numeric?: boolean;
    placeholder?: string;
    onEdit: (text: string) => void;
    onReset: () => void;
}

export function ValueField(props: ValueFieldProps) {
    return (
        <div className={css.field}>
            <div className={css.head}>
                <label className={css.label} htmlFor={props.id}>{props.label}</label>
                {props.overridden ? (
                    <span className={css.badges}>
                        <span className={css.badge}>{props.overriddenLabel}</span>
                        <button type="button" className={css.reset} disabled={props.disabled} onClick={props.onReset}>{props.resetLabel}</button>
                    </span>
                ) : null}
            </div>
            <input
                id={props.id}
                className={props.invalid ? `${css.input} ${css.inputInvalid}` : css.input}
                type="text"
                {...props.numeric ? { inputMode: 'numeric' as const } : {}}
                {...props.invalid ? { 'aria-invalid': true } : {}}
                value={props.text}
                placeholder={props.placeholder ?? ''}
                disabled={props.disabled}
                onChange={(event) => { props.onEdit(event.target.value); }}
            />
            <p className={props.invalid ? css.invalid : css.hint}>{props.invalid ? props.invalidLabel : props.hint}</p>
        </div>
    );
}

export interface SecretFieldProps {
    id: string;
    label: string;
    hint: string;
    text: string;
    configured: boolean;
    stateLabel: string;
    disabled: boolean;
    onEdit: (text: string) => void;
}

export function SecretField(props: SecretFieldProps) {
    return (
        <div className={css.field}>
            <div className={css.head}>
                <label className={css.label} htmlFor={props.id}>{props.label}</label>
                <span className={css.badges}>
                    <span className={props.configured ? css.badge : css.badgeMuted}>{props.stateLabel}</span>
                </span>
            </div>
            <input
                id={props.id}
                className={css.input}
                type="password"
                autoComplete="off"
                value={props.text}
                disabled={props.disabled}
                onChange={(event) => { props.onEdit(event.target.value); }}
            />
            <p className={css.hint}>{props.hint}</p>
        </div>
    );
}
