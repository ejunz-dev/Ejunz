import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import moment, { isMoment, Moment } from 'moment-timezone';
import Logger from 'reggol';
export * as yaml from 'js-yaml';
export * as fs from 'fs-extra';

Logger.levels.base = process.env.DEV ? 3 : 2;
Logger.targets[0].showTime = 'dd hh:mm:ss';
Logger.targets[0].label = {
    align: 'right',
    width: 9,
    margin: 1,
};

export { Logger, moment };
 function errorMessage(err: Error | string) {
    const t = typeof err === 'string' ? err : err.stack;
    const lines = t.split('\n')
        .filter((i) => !i.includes(' (node:') && !i.includes('(internal'));
    let cursor = 1;
    let count = 0;
    while (cursor < lines.length) {
        if (lines[cursor] !== lines[cursor - 1]) {
            if (count) {
                lines[cursor - 1] += ` [+${count}]`;
                count = 0;
            }
            cursor++;
        } else {
            count++;
            lines.splice(cursor, 1);
        }
    }
    const parsed = lines.join('\n')
        .replace(/[A-Z]:\\.+\\@ejunz\\/g, '@ejunz\\')
        .replace(/\/.+\/@ejunz\//g, '\\')
        .replace(/[A-Z]:\\.+\\ejun\\/g, 'ejun\\')
        .replace(/\/.+\/ejun\//g, 'ejun/')
        .replace(/[A-Z]:\\.+\\node_modules\\/g, '')
        .replace(/\/.+\/node_modules\//g, '')
        .replace(/\\/g, '/');
    if (typeof err === 'string') return parsed;
    err.stack = parsed;
    return err;
}
export function findFileSync(pathname: string, doThrow: boolean | Error = true) {
    if (fs.pathExistsSync(path.resolve(pathname))) return path.resolve(pathname);
    if (fs.pathExistsSync(path.resolve(process.cwd(), pathname))) return path.resolve(process.cwd(), pathname);
    if (fs.pathExistsSync(path.resolve(__dirname, pathname))) return path.resolve(__dirname, pathname);
    try {
        return require.resolve(pathname);
    } catch (e) { }
    if (pathname.includes('/')) {
        const eles = pathname.split('/');
        let pkg = eles.shift();
        if (pkg.startsWith('@')) pkg = `${pkg}/${eles.shift()}`;
        const rest = eles.join('/');
        try {
            const p = path.dirname(require.resolve(path.join(pkg, 'package.json')));
            if (fs.statSync(path.resolve(p, rest))) return path.resolve(p, rest);
        } catch (e) { }
    }
    if (fs.pathExistsSync(path.resolve(os.homedir(), pathname))) return path.resolve(os.homedir(), pathname);
    if (fs.pathExistsSync(path.resolve(os.homedir(), '.ejunz', pathname))) return path.resolve(os.homedir(), '.ejunz', pathname);
    if (fs.pathExistsSync(path.resolve(os.homedir(), '.config', 'ejunz', pathname))) return path.resolve(os.homedir(), '.config', 'ejunz', pathname);
    if (doThrow) throw (typeof doThrow !== 'boolean' ? doThrow : new Error(`File ${pathname} not found`));
    return null;
}