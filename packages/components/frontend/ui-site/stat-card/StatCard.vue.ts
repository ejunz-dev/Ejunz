import { defineComponent, h } from 'vue';

export const StatCard = defineComponent({
  name: 'EjStatCard',
  props: {
    label: { type: String, required: true },
    value: { type: [String, Number], required: true },
    accent: { type: String, default: '' },
  },
  setup(props, { attrs }) {
    return () => h('div', { ...attrs, class: ['ej-stat', attrs.class].filter(Boolean) }, [
      h('div', { class: 'ej-stat__label' }, props.label),
      h('div', {
        class: 'ej-stat__value',
        style: props.accent ? { color: props.accent } : undefined,
      }, String(props.value)),
    ]);
  },
});

export default StatCard;
