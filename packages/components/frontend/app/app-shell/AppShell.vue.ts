import { defineComponent, h } from 'vue';

export const AppShell = defineComponent({
  name: 'EjAppShell',
  props: {
    eyebrow: { type: String, default: 'EJUNZ UI' },
    title: { type: String, default: '组件库' },
    metaLeft: { type: String, default: '' },
    metaRight: { type: String, default: '' },
    minimal: { type: Boolean, default: false },
    bottomNav: { type: Boolean, default: false },
  },
  setup(props, { slots, attrs }) {
    return () => {
      const children: any[] = [];
      if (!props.minimal) {
        children.push(h('div', { class: 'ej-shell__topbar' }, [
          h('div', [
            h('span', { class: 'ej-shell__eyebrow' }, props.eyebrow),
            h('span', { class: 'ej-shell__title' }, slots.title?.() || props.title),
          ]),
          h('span', { class: 'ej-shell__dot', 'aria-hidden': 'true' }),
        ]));
        if (props.metaLeft || props.metaRight || slots.metaLeft || slots.metaRight) {
          children.push(h('div', { class: 'ej-shell__meta' }, [
            h('span', slots.metaLeft?.() || props.metaLeft),
            h('span', slots.metaRight?.() || props.metaRight),
          ]));
        }
      }
      children.push(slots.default?.());
      return h('div', {
        ...attrs,
        class: [
          'ej-shell',
          props.bottomNav ? 'ej-shell--bottom-nav' : '',
          attrs.class,
        ].filter(Boolean),
      }, children);
    };
  },
});

export default AppShell;
