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
const customDir = path.resolve(os.homedir(), 'ejunz/private/');
const domainDir = path.resolve(os.homedir(), 'ejunz/plugins/ejunz.com/Premium/');

export function register(cli: CAC) {
    cli.command('addon [operation] [name]').action((operation, name) => {
        if (operation && !['add', 'remove', 'create', 'list', 'domain', 'plugin', 'space'].includes(operation)) {
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
        } else if (operation === 'plugin') {
            const dir = `${domainDir}/plugins/${name || 'addon'}`;
            fs.mkdirSync(dir, { recursive: true });
            child.execSync('yarn init -y', { cwd: dir });
            fs.mkdirSync(`${dir}/templates`);
            fs.mkdirSync(`${dir}/frontend`);
            fs.writeFileSync(`${dir}/index.ts`, '');
            fs.writeFileSync(`${dir}/setting.yaml`, '');
            addons.push(dir);
            logger.success(`Plugin addon created at ${dir}`);
        }
        else if (operation === 'space') {
            const dir = `${domainDir}/spaces/${name || 'addon'}`;
            fs.mkdirSync(dir, { recursive: true });
            child.execSync('yarn init -y', { cwd: dir });
            fs.mkdirSync(`${dir}/templates`);
            fs.mkdirSync(`${dir}/frontend`);
            fs.writeFileSync(`${dir}/index.ts`, '');
            fs.writeFileSync(`${dir}/setting.yaml`, '');
            addons.push(dir);
            logger.success(`Space addon created at ${dir}`);
        }
         else if (operation && name) {
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
