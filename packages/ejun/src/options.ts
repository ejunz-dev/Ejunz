import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { findFileSync, Logger } from '@ejunz/utils/lib/utils';

const logger = new Logger('options');

function loadEnvFile(file: string) {
    const content = fs.readFileSync(file).toString().replace(/\r/g, '');
    for (const line of content.split('\n')) {
        if (!line.includes('=')) continue;
        process.env[line.split('=')[0]] = line.split('=')[1].trim();
    }
}

const profile = process.env.EJUNZ_PROFILE;
export const ejunzPath = profile ? path.resolve(os.homedir(), '.ejunz', 'profiles', profile) : path.resolve(os.homedir(), '.ejunz');
if (profile && !fs.existsSync(ejunzPath)) {
    logger.error('Profile %s not found', profile);
    process.exit(1);
} else fs.ensureDirSync(ejunzPath);
const addonPath = path.resolve(ejunzPath, 'addon.json');

export function load() {
    const envFile = path.resolve(ejunzPath, 'env');
    if (fs.existsSync(envFile)) loadEnvFile(envFile);
    const f = profile ? path.resolve(ejunzPath, 'config.json') : findFileSync('config.json', false);
    if (!f) return null;
    let result: any = {};
    try {
        result = JSON.parse(fs.readFileSync(f, 'utf-8'));
    } catch (e) {
        logger.error('Cannot read config file %o', e);
        result = {};
    }
    return result;
}

export function getAddons() {
    if (!fs.existsSync(addonPath)) fs.writeFileSync(addonPath, '[]');
    return JSON.parse(fs.readFileSync(addonPath).toString());
}

export function writeAddons(addons: string[]) {
    fs.writeFileSync(addonPath, JSON.stringify(addons, null, 2));
}
