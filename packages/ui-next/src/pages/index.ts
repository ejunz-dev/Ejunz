import { registerPage } from '../registry/page';

registerPage('homepage', () => import('./homepage'));
registerPage('home_domain', () => import('./home_domain'));
registerPage('base_domain', () => import('./basedomain'));
registerPage('user_login', () => import('./login'));
registerPage('base_detail', () => import('./base_detail'));
registerPage('lesson', () => import('./lesson'));
registerPage('learn_lesson', () => import('./lesson'));
registerPage('market', () => import('./market'));
registerPage('agent', () => import('./agent/page'));
registerPage('agent_workspace', () => import('./agent/page'));
registerPage('agent_list', () => import('./agent/list'));
registerPage('ejunz_agent_link', () => import('./agent/link'));
registerPage('ejunz_agent_status', () => import('./agent/status'));
