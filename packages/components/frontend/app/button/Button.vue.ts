import { defineComponent, h, type PropType } from 'vue';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** Vue 3 writing style — defineComponent + render function */
export const Button = defineComponent({
  name: 'EjButton',
  props: {
    variant: {
      type: String as PropType<ButtonVariant>,
      default: 'primary',
    },
    disabled: {
      type: Boolean,
      default: false,
    },
    type: {
      type: String as PropType<'button' | 'submit' | 'reset'>,
      default: 'button',
    },
  },
  emits: ['click'],
  setup(props, { slots, emit, attrs }) {
    return () => h(
      'button',
      {
        ...attrs,
        type: props.type,
        disabled: props.disabled,
        class: ['ej-button', `ej-button--${props.variant}`, attrs.class].filter(Boolean),
        onClick: (event: MouseEvent) => emit('click', event),
      },
      slots.default?.(),
    );
  },
});

export default Button;
