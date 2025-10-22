import AutoComplete, { AutoCompleteOptions } from '.';
import RepoSelectAutoCompleteFC from './components/RepoSelectAutoComplete';

export default class RepoSelectAutoComplete<Multi extends boolean> extends AutoComplete {
  static DOMAttachKey = 'ucwRepoSelectAutoCompleteInstance';

  constructor($dom, options: AutoCompleteOptions<Multi> = {}) {
    super($dom, {
      classes: 'repo-select',
      component: RepoSelectAutoCompleteFC,
      props: {
        multi: options.multi,
        height: '34px',
      },
      ...options,
    });
  }
}

window.Ejunz.components.RepoSelectAutoComplete = RepoSelectAutoComplete;