"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.spawnAsync = exports.getWorkspaces = exports.cwd = void 0;

exports.cwd = process.cwd();
  
async function getWorkspaces() {
    const globby = await import('globby');  // 动态导入
    return globby.globby(require('../package.json').workspaces, {
        cwd: exports.cwd,
        deep: 0,
        onlyDirectories: true,
        expandDirectories: false,
    });
} 
exports.getWorkspaces = getWorkspaces;

async function spawnAsync(command, path) {
    const crossSpawn = await import('cross-spawn');  // 动态导入
    const args = command.split(/\s+/);
    const options = { stdio: 'inherit' };
    if (path) options.cwd = path;
    const child = crossSpawn.default(args[0], args.slice(1), options);
    return new Promise(function (resolve, reject) {
        child.on('close', resolve);
        child.on('error', reject);
    });
}
exports.spawnAsync = spawnAsync;
