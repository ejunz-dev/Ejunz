import child from 'child_process';
import os from 'os';
import path from 'path';
import { CAC } from 'cac';
import fs from 'fs-extra';
import { Logger } from '@ejunz/utils';
import { getAddons, writeAddons } from '../options';

const logger = new Logger('addon');
const addonDir = path.resolve(os.homedir(), '.ejunz', 'addons');
const pluginDir = path.resolve(os.homedir(), 'root/ejunz/plugins/');
const customDir = path.resolve(os.homedir(), 'ejunz/plugins/Custom_domains');

export function register(cli: CAC) {
    cli.command('addon [operation] [name]').action((operation, name) => {
        if (operation && !['add', 'remove', 'create', 'list', 'domain'].includes(operation)) {
            console.log('Unknown operation.');
            return;
        }
        let addons = getAddons();
        if (operation === 'create') {
            const dir = `${pluginDir}/${name || 'addon'}`;
            fs.mkdirSync(dir, { recursive: true });
            child.execSync('yarn init -y', { cwd: dir });
            fs.mkdirSync(`${dir}/templates`);
            fs.mkdirSync(`${dir}/locales`);
            fs.mkdirSync(`${dir}/public`);
            fs.mkdirSync(`${dir}/frontend`);
            fs.symlinkSync(dir, path.resolve(os.homedir(), name || 'addon'), 'dir');
            addons.push(dir);
            logger.success(`Addon created at ${dir}`);
        } else if (operation === 'domain') {
            const dir = `${customDir}/${name || 'addon'}`;
            fs.mkdirSync(dir, { recursive: true });
            fs.mkdirSync(`${dir}/main`, { recursive: true });
            fs.mkdirSync(`${dir}/plugins`, { recursive: true });
            fs.mkdirSync(`${dir}/spaces`, { recursive: true });
            child.execSync('yarn init -y', { cwd: `${dir}/main` });
            fs.mkdirSync(`${dir}/main/templates`);
            fs.mkdirSync(`${dir}/main/locales`);
            fs.mkdirSync(`${dir}/main/public`);
            fs.mkdirSync(`${dir}/main/frontend`);

            const symlinkPath = path.resolve(os.homedir(), name || 'addon');
            if (!fs.existsSync(symlinkPath)) {
                fs.symlinkSync(`${dir}/main`, symlinkPath, 'dir');
            }
            
            addons.push(`${dir}/main`);
            logger.success(`Domain addon created at ${dir}/main`);
        } else if (operation && name) {
            for (let i = 0; i < addons.length; i++) {
                if (addons[i] === name) {
                    addons.splice(i, 1);
                    break;
                }
            }
        }

        if (operation === 'add' && name) {
            try {
                require.resolve(`${name}/package.json`);
            } catch (e) {
                logger.error(`Addon not found or not available: ${name}`);
                return;
            }
            addons.push(name);
        }
        addons = Array.from(new Set(addons));
        logger.info('Current Addons: ');
        console.log(addons);
        writeAddons(addons);
    });
}
