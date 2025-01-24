import type { RepoDoc } from 'ejun/src/interface';
import PropTypes from 'prop-types';
import React, { forwardRef } from 'react';
import { api, gql, request } from 'vj/utils';
import AutoComplete, { AutoCompleteHandle, AutoCompleteProps } from './AutoComplete';

const RepoSelectAutoComplete = forwardRef<AutoCompleteHandle<RepoDoc>, AutoCompleteProps<RepoDoc>>((props, ref) => (
  <AutoComplete<RepoDoc>
    ref={ref as any}
    cacheKey={`repos-${UiContext.domainId}`}
    
    queryItems={async (query) => {
        const response = await request.get(`/d/${UiContext.domainId}/repo`, { q: query, quick: true });
        const rdocs = response?.rdocs || [];
        return rdocs.filter((d) =>
          d.title.includes(query) || 
          d.rid.includes(query) || 
          d.docId.toString() === query 
        );
        
    }}
    fetchItems={(ids) => api(gql`
      repos(ids: ${ids.map((i) => +i)}) {
          docId
          rid
          title
      }
    `,['data', 'repos'])}

    itemText={(rdoc) => `${rdoc.docId} ${rdoc.title}`}
    itemKey={(rdoc) => `${rdoc.docId || rdoc}`}

    renderItem={(rdoc) => (
      <div className="media">
        <div className="media__body medium">
          <div className="repos-select__name">
            {rdoc.rid ? `${rdoc.rid} ` : ''} {rdoc.title}
          </div>
          <div className="repos-select__id">ID = {rdoc.docId}</div>
        </div>
      </div>
    )}
    
    {...props}
  />
));

RepoSelectAutoComplete.propTypes = {
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

RepoSelectAutoComplete.defaultProps = {
  width: '100%',
  height: 'auto',
  listStyle: {},
  multi: false,
  selectedKeys: [],
  allowEmptyQuery: false,
  freeSolo: false,
  freeSoloConverter: (input) => input,
};

RepoSelectAutoComplete.displayName = 'RepoSelectAutoComplete';

export default RepoSelectAutoComplete;
