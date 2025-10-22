import AutoComplete, { AutoCompleteOptions } from '.';
import DomainSelectAutoCompleteFC from './components/DomainSelectAutoComplete';

export default class DocsSelectAutoComplete<Multi extends boolean> extends AutoComplete {
  static DOMAttachKey = 'ucwDocsSelectAutoCompleteInstance';

  constructor($dom, options: AutoCompleteOptions<Multi> = {}) {
    super($dom, {
      classes: 'docs-select',
      component: DomainSelectAutoCompleteFC,
      props: {
        multi: options.multi,
        height: '34px',
      },
      ...options,
    });
  }
}

window.Ejunz.components.DocsSelectAutoComplete = DocsSelectAutoComplete;