import { defineComponent, h } from 'vue';

export const WebSearchTrigger = defineComponent({
  name: 'EjWebSearchTrigger',
  props: {
    label: { type: String, default: 'Search' },
    shortcut: { type: String, default: '⌘ K' },
  },
  emits: ['click'],
  setup(props, { emit, attrs }) {
    return () => h(
      'button',
      {
        ...attrs,
        type: 'button',
        class: ['ej-web-search', attrs.class].filter(Boolean),
        onClick: (e: MouseEvent) => emit('click', e),
      },
      [
        h('span', { class: 'ej-web-search__icon', 'aria-hidden': 'true' }, '⌕'),
        h('span', { class: 'ej-web-search__label' }, props.label),
        h('kbd', { class: 'ej-web-search__kbd' }, props.shortcut),
      ],
    );
  },
});

export default WebSearchTrigger;
