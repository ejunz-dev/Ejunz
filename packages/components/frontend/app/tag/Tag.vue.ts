import { defineComponent, h, type PropType } from 'vue';

export type TagTone = 'accent' | 'neutral' | 'danger';

export const Tag = defineComponent({
  name: 'EjTag',
  props: {
    tone: { type: String as PropType<TagTone>, default: 'accent' },
  },
  setup(props, { slots, attrs }) {
    return () => {
      const toneClass = props.tone === 'accent' ? '' : `ej-tag--${props.tone}`;
      return h('span', {
        ...attrs,
        class: ['ej-tag', toneClass, attrs.class].filter(Boolean),
      }, slots.default?.());
    };
  },
});

export default Tag;
