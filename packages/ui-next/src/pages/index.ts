import { registerPage } from '../dom/registry';
import { basedomain } from './dom';
import { homepage } from './homepage';
import { login } from './login';

registerPage('homepage', homepage);
registerPage('basedomain', basedomain);
registerPage('user_login', login);
