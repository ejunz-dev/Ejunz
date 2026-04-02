import { combineReducers } from 'redux';
import editor from './editor';
import pretest from './pretest';
import rounds from './rounds';
import state from './state';
import ui from './ui';

const reducer = combineReducers({
  ui,
  editor,
  pretest,
  records: rounds,
  state,
});

export default reducer;
export type RootState = ReturnType<typeof reducer>;
