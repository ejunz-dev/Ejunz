import React from 'react';
import ReactDOM from 'react-dom/client';
import AutoComplete from '.';
import RepoSelectAutoCompleteFC from './components/RepoSelectAutoComplete';

const Component = React.forwardRef<any, any>((props, ref) => {
  const [value, setValue] = React.useState(props.value ?? '');
  return (
    <RepoSelectAutoCompleteFC
      ref={ref as any}
      height="auto"
      selectedKeys={value.split(',').map((i) => i.trim()).filter((i) => i)}
      onChange={(v) => {
        setValue(v);
        props.onChange(v);
      }}
      multi={props.multi}
    />
  );
});

export default class RepoSelectAutoComplete extends AutoComplete {
  static DOMAttachKey = 'ucwRepoSelectAutoCompleteInstance';

  constructor($dom, options) {
    super($dom, {
      classes: 'doc-select',
      ...options,
    });
  }

  attach() {
    const value = this.$dom.val();
    ReactDOM.createRoot(this.container).render(
      <Component
        ref={(ref) => { this.ref = ref; }}
        value={value}
        multi={this.options.multi}
        onChange={this.onChange}
      />,
    );
  }
}

window.Ejunz.components.RepoSelectAutoComplete = RepoSelectAutoComplete;
