import { defineComponent, h } from 'vue';

export const EmptyState = defineComponent({
  name: 'EjEmptyState',
  props: {
    text: { type: String, default: '暂无数据' },
  },
  setup(props, { attrs }) {
    return () => h('div', { ...attrs, class: ['ej-empty', attrs.class].filter(Boolean) }, [
      h('span', { class: 'ej-empty__icon' }, '—'),
      h('span', props.text),
    ]);
  },
});

export default EmptyState;
