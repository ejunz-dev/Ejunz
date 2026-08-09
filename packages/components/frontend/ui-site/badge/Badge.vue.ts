import { defineComponent, h, type PropType } from 'vue';

export type BadgeTone = 'accent' | 'neutral' | 'danger';

export const Badge = defineComponent({
  name: 'EjBadge',
  props: {
    tone: {
      type: String as PropType<BadgeTone>,
      default: 'accent',
    },
  },
  setup(props, { slots, attrs }) {
    return () => {
      const toneClass = props.tone === 'accent' ? '' : `ej-badge--${props.tone}`;
      return h(
        'span',
        {
          ...attrs,
          class: ['ej-badge', toneClass, attrs.class].filter(Boolean),
        },
        slots.default?.(),
      );
    };
  },
});

export default Badge;
