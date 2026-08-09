import { defineComponent, h, type PropType } from 'vue';

export type WebButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost';

export const WebButton = defineComponent({
  name: 'EjWebButton',
  props: {
    variant: {
      type: String as PropType<WebButtonVariant>,
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
        class: ['ej-web-button', `ej-web-button--${props.variant}`, attrs.class].filter(Boolean),
        onClick: (event: MouseEvent) => emit('click', event),
      },
      slots.default?.(),
    );
  },
});

export default WebButton;
