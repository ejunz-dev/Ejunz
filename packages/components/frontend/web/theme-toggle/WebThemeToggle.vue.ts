import { defineComponent, h, type PropType } from 'vue';

export const WebThemeToggle = defineComponent({
  name: 'EjWebThemeToggle',
  props: {
    mode: { type: String as PropType<'light' | 'dark'>, default: 'dark' },
  },
  emits: ['change'],
  setup(props, { emit, attrs }) {
    return () => h('div', {
      ...attrs,
      class: ['ej-web-theme', `ej-web-theme--${props.mode}`, attrs.class].filter(Boolean),
      role: 'group',
      'aria-label': 'Theme',
    }, [
      h('span', { class: 'ej-web-theme__thumb', 'aria-hidden': 'true' }),
      h('button', {
        type: 'button',
        class: ['ej-web-theme__btn', props.mode === 'light' ? 'is-active' : ''].filter(Boolean),
        'aria-pressed': props.mode === 'light',
        title: 'Light',
        onClick: () => emit('change', 'light'),
      }, '☀'),
      h('button', {
        type: 'button',
        class: ['ej-web-theme__btn', props.mode === 'dark' ? 'is-active' : ''].filter(Boolean),
        'aria-pressed': props.mode === 'dark',
        title: 'Dark',
        onClick: () => emit('change', 'dark'),
      }, '☾'),
    ]);
  },
});

export default WebThemeToggle;
