import { registerPage } from '../registry/page';

registerPage('homepage', () => import('./homepage'));
registerPage('base_domain', () => import('./basedomain'));
registerPage('user_login', () => import('./login'));
registerPage('base_detail', () => import('./base_detail'));
registerPage('lesson', () => import('./lesson'));
registerPage('learn_lesson', () => import('./lesson'));
registerPage('agent', () => import('./agent/page'));
registerPage('ejunz_agent_link', () => import('./agent/link'));
registerPage('ejunz_agent_status', () => import('./agent/status'));
