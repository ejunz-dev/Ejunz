import { registerPage } from '../registry/page';

registerPage('homepage', () => import('./homepage'));
registerPage('base_domain', () => import('./basedomain'));
