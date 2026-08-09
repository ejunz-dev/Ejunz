import { defineComponent, h, type PropType } from 'vue';

export const WebCard = defineComponent({
  name: 'EjWebCard',
  props: {
    title: { type: String, required: true },
    description: { type: String, default: '' },
    href: { type: String as PropType<string | undefined>, default: undefined },
  },
  setup(props, { slots, attrs }) {
    return () => {
      const classes = ['ej-web-card', props.href ? 'ej-web-card--link' : '', attrs.class].filter(Boolean);
      const children = [
        h('h3', { class: 'ej-web-card__title' }, props.title),
        props.description ? h('p', { class: 'ej-web-card__desc' }, props.description) : null,
        slots.default ? h('div', { class: 'ej-web-card__extra' }, slots.default()) : null,
      ];
      if (props.href) {
        return h('a', { ...attrs, class: classes, href: props.href, 'data-card': 'true' }, children);
      }
      return h('div', { ...attrs, class: classes, 'data-card': 'true' }, children);
    };
  },
});

export default WebCard;
