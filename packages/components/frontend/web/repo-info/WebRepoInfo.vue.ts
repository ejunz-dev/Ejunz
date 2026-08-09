import { defineComponent, h } from 'vue';

function humanizeNumber(num: number) {
  if (num < 1000) return String(num);
  if (num < 100000) {
    const value = (num / 1000).toFixed(1);
    return `${value.endsWith('.0') ? value.slice(0, -2) : value}K`;
  }
  if (num < 1000000) return `${Math.floor(num / 1000)}K`;
  return String(num);
}

export const WebRepoInfo = defineComponent({
  name: 'EjWebRepoInfo',
  props: {
    owner: { type: String, required: true },
    repo: { type: String, required: true },
    stars: { type: Number, default: null },
  },
  setup(props, { attrs }) {
    return () => h(
      'a',
      {
        ...attrs,
        class: ['ej-web-repo', attrs.class].filter(Boolean),
        href: `https://github.com/${props.owner}/${props.repo}`,
        rel: 'noreferrer noopener',
        target: '_blank',
      },
      [
        h('span', { class: 'ej-web-repo__path' }, [
          h('span', { class: 'ej-web-repo__icon', 'aria-hidden': 'true' }, '⌥'),
          `${props.owner}/${props.repo}`,
        ]),
        props.stars != null
          ? h('span', { class: 'ej-web-repo__stars' }, `★ ${humanizeNumber(props.stars)}`)
          : null,
      ],
    );
  },
});

export default WebRepoInfo;
