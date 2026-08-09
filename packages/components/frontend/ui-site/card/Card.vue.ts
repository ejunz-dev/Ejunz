import { defineComponent, h } from 'vue';

export const Card = defineComponent({
  name: 'EjCard',
  props: {
    title: {
      type: String,
      default: '',
    },
  },
  setup(props, { slots, attrs }) {
    return () => h(
      'article',
      {
        ...attrs,
        class: ['ej-card', attrs.class].filter(Boolean),
      },
      [
        props.title ? h('h3', { class: 'ej-card__title' }, props.title) : null,
        h('div', { class: 'ej-card__body' }, slots.default?.()),
      ],
    );
  },
});

export default Card;
