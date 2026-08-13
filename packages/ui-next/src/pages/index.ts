import { registerPage } from '../registry/page';

registerPage('homepage', () => import('./homepage'));
registerPage('basedomain', () => import('./basedomain'));
