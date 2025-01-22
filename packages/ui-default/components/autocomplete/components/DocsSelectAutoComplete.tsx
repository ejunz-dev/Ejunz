import type { DocsDoc } from '@ejunz/ejunzdocs';
import PropTypes from 'prop-types';
import React, { forwardRef } from 'react';
import { api, gql, request } from 'vj/utils';
import AutoComplete, { AutoCompleteHandle, AutoCompleteProps } from './AutoComplete';

const DocsSelectAutoComplete = forwardRef<AutoCompleteHandle<DocsDoc>, AutoCompleteProps<DocsDoc>>((props, ref) => (
  <AutoComplete<DocsDoc>
    ref={ref as any}
    cacheKey={`docs-${UiContext.domainId}`}
    
    queryItems={async (query) => {
      const { docs } = await api(gql`
        query {
          docs(ids: []) {
            lid
            title
          }
        }
      `, ['data', 'docs']);
      
      return docs.filter(d => d.title.includes(query) || d.lid.toString().includes(query));
    }}

    fetchItems={(ids) => api(gql`
      docs(ids: ${ids.map((i) => parseInt(i, 10))}) {
        lid
        title
        content
      }
    `, ['data', 'docs'])}

    itemText={(ddoc) => `${ddoc.lid} ${ddoc.title}`}
    itemKey={(ddoc) => `${ddoc.lid || ddoc}`}
    
    renderItem={(ddoc) => (
      <div className="media">
        <div className="media__body medium">
          <div className="doc-select__name">
            {ddoc.lid ? `#${ddoc.lid} ` : ''} {ddoc.title}
          </div>
          <div className="doc-select__id">文档 ID = {ddoc.lid}</div>
        </div>
      </div>
    )}
    
    {...props}
  />
));

DocsSelectAutoComplete.propTypes = {
  width: PropTypes.string,
  height: PropTypes.string,
  listStyle: PropTypes.object,
  onChange: PropTypes.func.isRequired,
  multi: PropTypes.bool,
  selectedKeys: PropTypes.arrayOf(PropTypes.string),
  allowEmptyQuery: PropTypes.bool,
  freeSolo: PropTypes.bool,
  freeSoloConverter: PropTypes.func,
};

DocsSelectAutoComplete.defaultProps = {
  width: '100%',
  height: 'auto',
  listStyle: {},
  multi: false,
  selectedKeys: [],
  allowEmptyQuery: false,
  freeSolo: false,
  freeSoloConverter: (input) => input,
};

DocsSelectAutoComplete.displayName = 'DocsSelectAutoComplete';

export default DocsSelectAutoComplete;
