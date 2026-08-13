import { registerPage } from '../dom/registry';
import { basedomain } from './dom';
import { homepage } from './homepage';

registerPage('homepage', homepage);
registerPage('basedomain', basedomain);
