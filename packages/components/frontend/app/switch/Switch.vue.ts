import { defineComponent, h } from 'vue';

export const Switch = defineComponent({
  name: 'EjSwitch',
  props: {
    checked: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
  },
  emits: ['update:checked', 'change'],
  setup(props, { emit, attrs }) {
    return () => h('button', {
      ...attrs,
      type: 'button',
      role: 'switch',
      'aria-checked': props.checked,
      disabled: props.disabled,
      class: ['ej-switch', props.checked ? 'is-on' : '', attrs.class].filter(Boolean),
      onClick: () => {
        if (props.disabled) return;
        emit('update:checked', !props.checked);
        emit('change', !props.checked);
      },
    }, [h('span', { class: 'ej-switch__thumb' })]);
  },
});

export default Switch;
