import { defineComponent, h, type PropType } from 'vue';

export type WebCalloutType = 'info' | 'warn' | 'error';

const icons: Record<WebCalloutType, string> = {
  info: 'ℹ',
  warn: '⚠',
  error: '✕',
};

export const WebCallout = defineComponent({
  name: 'EjWebCallout',
  props: {
    type: { type: String as PropType<WebCalloutType>, default: 'info' },
    title: { type: String, default: '' },
  },
  setup(props, { slots, attrs }) {
    return () => h(
      'div',
      {
        ...attrs,
        class: ['ej-web-callout', `ej-web-callout--${props.type}`, attrs.class].filter(Boolean),
      },
      [
        h('span', { class: 'ej-web-callout__icon', 'aria-hidden': 'true' }, icons[props.type]),
        h('div', { class: 'ej-web-callout__body' }, [
          props.title ? h('p', { class: 'ej-web-callout__title' }, props.title) : null,
          h('div', { class: 'ej-web-callout__content' }, slots.default?.()),
        ]),
      ],
    );
  },
});

export default WebCallout;
