import { registerPage } from '../registry/page';

registerPage('homepage', () => import('./homepage'));
registerPage('base_domain', () => import('./basedomain'));
registerPage('user_login', () => import('./login'));
registerPage('base_detail', () => import('./base_detail'));
