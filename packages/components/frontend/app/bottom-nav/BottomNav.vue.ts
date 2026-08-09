import { defineComponent, h, onBeforeUnmount, ref, type PropType } from 'vue';

export type BottomNavItem = { key: string; icon: string; label: string };

export const BottomNav = defineComponent({
  name: 'EjBottomNav',
  props: {
    current: { type: String, required: true },
    items: { type: Array as PropType<BottomNavItem[]>, required: true },
  },
  emits: ['change'],
  setup(props, { emit, attrs }) {
    const compact = ref(typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 640);
    const onResize = () => { compact.value = window.innerWidth > 0 && window.innerWidth < 640; };
    if (typeof window !== 'undefined') window.addEventListener('resize', onResize);
    onBeforeUnmount(() => {
      if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
    });

    return () => h(
      'nav',
      {
        ...attrs,
        class: ['ej-bottom-nav', compact.value ? 'ej-bottom-nav--compact' : '', attrs.class].filter(Boolean),
      },
      props.items.map((item) => h(
        'button',
        {
          type: 'button',
          class: ['ej-bottom-nav__item', item.key === props.current ? 'is-active' : ''].filter(Boolean),
          onClick: () => emit('change', item.key),
        },
        [
          h('span', { class: 'ej-bottom-nav__icon' }, item.icon),
          compact.value ? null : h('span', { class: 'ej-bottom-nav__label' }, item.label),
        ],
      )),
    );
  },
});

export default BottomNav;
