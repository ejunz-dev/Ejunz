import { defineComponent, h } from 'vue';

export const ListRow = defineComponent({
  name: 'EjListRow',
  props: {
    title: { type: String, required: true },
    description: { type: String, default: '' },
    meta: { type: String, default: '' },
    avatarText: { type: String, default: '' },
  },
  emits: ['click'],
  setup(props, { emit, attrs }) {
    return () => h('button', {
      ...attrs,
      type: 'button',
      class: ['ej-list-row', attrs.class].filter(Boolean),
      onClick: () => emit('click'),
    }, [
      h('span', { class: 'ej-list-row__avatar' }, props.avatarText || props.title.charAt(0).toUpperCase()),
      h('span', { class: 'ej-list-row__main' }, [
        h('span', { class: 'ej-list-row__title' }, props.title),
        props.description ? h('span', { class: 'ej-list-row__desc' }, props.description) : null,
        props.meta ? h('span', { class: 'ej-list-row__meta' }, props.meta) : null,
      ]),
      h('span', { class: 'ej-list-row__chevron' }, '›'),
    ]);
  },
});

export default ListRow;
