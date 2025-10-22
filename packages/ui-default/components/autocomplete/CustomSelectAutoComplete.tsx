import { CustomSelectAutoComplete as CustomSelectAutoCompleteFC } from '@ejunz/components';
import AutoComplete, { AutoCompleteOptions } from '.';

interface CustomSelectOptions {
  data: any[];
}

export default class CustomSelectAutoComplete<Multi extends boolean> extends AutoComplete<CustomSelectOptions> {
  static DOMAttachKey = 'ucwCustomSelectAutoCompleteInstance';

  constructor($dom, options: CustomSelectOptions & AutoCompleteOptions<Multi>) {
    super($dom, {
      classes: 'custom-select',
      component: CustomSelectAutoCompleteFC,
      props: {
        data: options.data,
        multi: options.multi,
        height: 'auto',
      },
      ...options,
    });
  }
}

window.Ejunz.components.CustomSelectAutoComplete = CustomSelectAutoComplete;