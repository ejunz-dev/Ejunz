import { defineComponent, h, type PropType } from 'vue';
import type { WebSidebarGroup, WebSidebarItem } from './WebSidebar.react';

export const WebSidebar = defineComponent({
  name: 'EjWebSidebar',
  props: {
    groups: { type: Array as PropType<WebSidebarGroup[]>, required: true },
    header: {
      type: Object as PropType<{ title: string; href?: string; active?: boolean } | null>,
      default: null,
    },
  },
  emits: ['navigate'],
  setup(props, { emit, attrs, slots }) {
    return () => h('aside', {
      ...attrs,
      class: ['ej-web-sidebar', attrs.class].filter(Boolean),
      'aria-label': 'Sidebar',
    }, [
      slots.banner ? h('div', { class: 'ej-web-sidebar__banner' }, slots.banner()) : null,
      props.header
        ? h('div', { class: 'ej-web-sidebar__header' }, [
          props.header.href
            ? h('a', {
              href: props.header.href,
              class: ['ej-web-sidebar__header-link', props.header.active ? 'is-active' : ''].filter(Boolean),
            }, props.header.title)
            : h('button', {
              type: 'button',
              class: ['ej-web-sidebar__header-link', props.header.active ? 'is-active' : ''].filter(Boolean),
              onClick: () => emit('navigate', { key: '__header', title: props.header!.title }),
            }, props.header.title),
        ])
        : null,
      h('nav', { class: 'ej-web-sidebar__nav' }, props.groups.map((group) => h('div', {
        key: group.title,
        class: 'ej-web-sidebar__group',
      }, [
        h('p', { class: 'ej-web-sidebar__label' }, group.title),
        h('ul', { class: 'ej-web-sidebar__list' }, group.items.map((item: WebSidebarItem) => h('li', { key: item.key }, [
          item.href
            ? h('a', {
              href: item.href,
              class: ['ej-web-sidebar__item', item.active ? 'is-active' : ''].filter(Boolean),
              onClick: () => emit('navigate', item),
            }, item.title)
            : h('button', {
              type: 'button',
              class: ['ej-web-sidebar__item', item.active ? 'is-active' : ''].filter(Boolean),
              onClick: () => emit('navigate', item),
            }, item.title),
        ]))),
      ]))),
    ]);
  },
});

export default WebSidebar;
