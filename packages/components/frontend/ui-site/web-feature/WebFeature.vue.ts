import { defineComponent, h, type PropType } from 'vue';

export const WebFeature = defineComponent({
  name: 'EjWebFeature',
  props: {
    title: { type: String, required: true },
    description: { type: String, default: '' },
    href: { type: String as PropType<string | undefined>, default: undefined },
  },
  setup(props, { slots, attrs }) {
    return () => {
      const classes = ['ej-web-feature', 'group', attrs.class].filter(Boolean);
      const heading = [
        h('h3', { class: 'ej-web-feature__title' }, props.title),
        props.description ? h('p', { class: 'ej-web-feature__desc' }, props.description) : null,
      ];
      const head = props.href
        ? h('a', { class: 'ej-web-feature__link', href: props.href }, heading)
        : heading;
      return h('div', { ...attrs, class: classes }, [head, slots.default?.()]);
    };
  },
});

export default WebFeature;
