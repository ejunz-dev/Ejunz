import { defineComponent, h, ref, type PropType } from 'vue';

export type WebRootToggleOption = {
  title: string;
  description?: string;
  url?: string;
  key?: string;
};

export const WebRootToggle = defineComponent({
  name: 'EjWebRootToggle',
  props: {
    options: { type: Array as PropType<WebRootToggleOption[]>, required: true },
    value: { type: String, default: '' },
    openOnHover: { type: Boolean, default: true },
  },
  emits: ['change'],
  setup(props, { emit, attrs }) {
    const open = ref(false);
    let leaveTimer: ReturnType<typeof setTimeout> | null = null;

    const clearLeave = () => {
      if (leaveTimer != null) {
        clearTimeout(leaveTimer);
        leaveTimer = null;
      }
    };
    const show = () => {
      clearLeave();
      open.value = true;
    };
    const hide = () => {
      clearLeave();
      leaveTimer = setTimeout(() => { open.value = false; }, 120);
    };

    return () => {
      const selected = props.options.find((o) => (o.key || o.title) === props.value) || props.options[0];
      return h('div', {
        ...attrs,
        class: ['ej-web-root-toggle', open.value ? 'is-open' : '', attrs.class].filter(Boolean),
        onMouseenter: props.openOnHover ? show : undefined,
        onMouseleave: props.openOnHover ? hide : undefined,
      }, [
        h('button', {
          type: 'button',
          class: 'ej-web-root-toggle__trigger',
          'aria-expanded': open.value,
          onClick: () => { open.value = !open.value; },
        }, [
          h('span', { class: 'ej-web-root-toggle__text' }, [
            h('span', { class: 'ej-web-root-toggle__title' }, selected?.title),
            selected?.description
              ? h('span', { class: 'ej-web-root-toggle__desc' }, selected.description)
              : null,
          ]),
          h('span', { class: 'ej-web-root-toggle__chev', 'aria-hidden': 'true' }, '▾'),
        ]),
        h('div', {
          class: 'ej-web-root-toggle__menu',
          role: 'listbox',
          'aria-hidden': !open.value,
        }, props.options.map((item) => {
          const key = item.key || item.title;
          const active = key === (selected?.key || selected?.title);
          return h('button', {
            key,
            type: 'button',
            role: 'option',
            'aria-selected': active,
            tabindex: open.value ? 0 : -1,
            class: ['ej-web-root-toggle__item', active ? 'is-active' : ''].filter(Boolean),
            onClick: () => {
              emit('change', key);
              open.value = false;
            },
          }, [
            h('span', { class: 'ej-web-root-toggle__title' }, item.title),
            item.description
              ? h('span', { class: 'ej-web-root-toggle__desc' }, item.description)
              : null,
          ]);
        })),
      ]);
    };
  },
});

export default WebRootToggle;
