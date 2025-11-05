import { UIInjectableFields } from '../interface';
import { PERM, PRIV } from '../model/builtin';

const trueChecker = () => true;
const Checker = (perm: bigint | bigint[], priv: number | number[], checker: Function = trueChecker) => (handler) => (
    checker(handler)
    && (perm ? handler.user.hasPerm(perm) : true)
    && (priv ? handler.user.hasPriv(priv) : true)
);
type PermPrivChecker = Array<number | bigint | Function | number[] | bigint[]>;
const buildChecker = (...permPrivChecker: PermPrivChecker) => {
    let _priv: number | number[];
    let _perm: bigint | bigint[];
    let checker: Function = trueChecker;
    for (const item of permPrivChecker) {
        if (typeof item === 'function') checker = item;
        else if (typeof item === 'number') _priv = item;
        else if (typeof item === 'bigint') _perm = item;
        else if (item instanceof Array) {
            if (typeof item[0] === 'number') _priv = item as number[];
            else _perm = item as bigint[];
        }
    }
    return Checker(_perm, _priv, checker);
};

export const nodes = new Proxy({}, {
    get(self, key) {
        self[key] ||= [];
        return self[key];
    },
});
export function inject(node: UIInjectableFields, name: string, args: Record<string, any> = {}, ...permPrivChecker: PermPrivChecker) {
    const obj = { name, args: args || {}, checker: buildChecker(...permPrivChecker) };
    const idx = obj.args.before ? nodes[node].findIndex((i) => i.name === obj.args.before) : -1;
    if (idx !== -1) {
        nodes[node] = nodes[node].filter((i) => i.name !== obj.name);
        nodes[node].splice(idx, 0, obj);
    } else nodes[node].push(obj);
    return () => { nodes[node] = nodes[node].filter((i) => i !== obj); };
}
export function getNodes(name: UIInjectableFields) {
    return nodes[name];
}
/** @deprecated */
export const Nav = (name, args, prefix, ...permPrivChecker) => {
    inject('Nav', name, { ...args, prefix }, ...permPrivChecker);
};
/** @deprecated */
export const ProblemAdd = (name, args, icon = 'add', text = 'Create Problem') => {
    inject('ProblemAdd', name, { ...args, icon, text });
};
export const RepoAdd = (name, args, icon = 'add', text = 'Create Repository') => {
    inject('RepoAdd', name, { ...args, icon, text });
};
export const AgentAdd = (name, args, icon = 'add', text = 'Create Agent') => {
    inject('AgentAdd', name, { ...args, icon, text });
};
// inject('NavMainDropdown', 'homepage', { prefix: 'homepage' });
// inject('NavMainDropdown', 'workspace_main', { prefix: 'workspace' });
// inject('NavMainDropdown', 'production_main', { prefix: 'productionhub' });
// inject('NavMainDropdown', 'processing_main', { prefix: 'processinghub' });
// inject('NavMainDropdown', 'teamspace_main', { prefix: 'teamspace' });
// inject('NavMainDropdown', 'talkspace_main');


inject('Nav', 'homepage', { prefix: 'homepage' });
inject('Nav', 'forest_domain', { prefix: 'forest' });
inject('Nav', 'repo_domain', { prefix: 'repo' });
inject('Nav', 'agent_domain', { prefix: 'agent' });
inject('Nav', 'discussion_main', { prefix: 'discussion' });



inject('NavDropdown', 'domain_dashboard', { prefix: 'domain' }, PERM.PERM_EDIT_DOMAIN);
inject('NavDropdown', 'manage_dashboard', { prefix: 'manage' }, PRIV.PRIV_EDIT_SYSTEM);
inject('ProblemAdd', 'problem_create', { icon: 'add', text: 'Create Problem' });
inject('RepoAdd', 'repo_create', { icon: 'add', text: 'Create Repository' });
inject('AgentAdd', 'agent_create', { icon: 'add', text: 'Create Agent' });
inject('ControlPanel', 'manage_dashboard');
inject('ControlPanel', 'manage_script');
inject('ControlPanel', 'manage_user_import');
inject('ControlPanel', 'manage_user_priv');
inject('ControlPanel', 'manage_setting');
inject('ControlPanel', 'manage_config');
inject('DomainManage', 'domain_dashboard', { family: 'Properties', icon: 'info' });
inject('DomainManage', 'domain_edit', { family: 'Properties', icon: 'info' });
inject('DomainManage', 'domain_join_applications', { family: 'Properties', icon: 'info' });
inject('DomainManage', 'domain_role', { family: 'Access Control', icon: 'user' });
inject('DomainManage', 'domain_user', { family: 'Access Control', icon: 'user' });
inject('DomainManage', 'domain_permission', { family: 'Access Control', icon: 'user' });
inject('DomainManage', 'domain_group', { family: 'Access Control', icon: 'user' });

global.Ejunz.ui.inject = inject;
global.Ejunz.ui.nodes = nodes as any;
global.Ejunz.ui.getNodes = getNodes;
Object.assign(global.Ejunz.ui, { ProblemAdd, Nav });