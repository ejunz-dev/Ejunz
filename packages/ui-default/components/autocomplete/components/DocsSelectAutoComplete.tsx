import type { DocsDoc } from 'ejun/src/interface';
import PropTypes from 'prop-types';
import React, { forwardRef } from 'react';
import { api, gql, request } from 'vj/utils';
import AutoComplete, { AutoCompleteHandle, AutoCompleteProps } from './AutoComplete';

const DocsSelectAutoComplete = forwardRef<AutoCompleteHandle<DocsDoc>, AutoCompleteProps<DocsDoc>>((props, ref) => (
  <AutoComplete<DocsDoc>
    ref={ref as any}
    cacheKey={`docs-${UiContext.domainId}`}
    
    queryItems={async (query) => {
      const { ddocs } = await request.get(`/d/${UiContext.domainId}/docs`, { q: query, quick: true });
      return ddocs.filter((d) =>
        d.title.includes(query) || 
        d.lid.includes(query) || 
        d.docId.toString() === query 
      );
    }}
    fetchItems={(ids) => api(gql`
      docs(ids: ${ids.map((i) => +i)}) {
          docId
          lid
          title
      }
    `,['data', 'docs'])}

    itemText={(ddoc) => `${ddoc.docId} ${ddoc.title}`}
    itemKey={(ddoc) => `${ddoc.docId || ddoc}`}

    renderItem={(ddoc) => (
      <div className="media">
        <div className="media__body medium">
          <div className="docs-select__name">
            {ddoc.lid ? `${ddoc.lid} ` : ''} {ddoc.title}
          </div>
          <div className="docs-select__id">ID = {ddoc.docId}</div>
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
