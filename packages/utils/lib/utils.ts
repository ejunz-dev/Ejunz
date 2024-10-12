import Logger from 'reggol';
import moment, { isMoment, Moment } from 'moment-timezone';

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