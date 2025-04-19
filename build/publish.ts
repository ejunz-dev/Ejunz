import { writeFileSync } from 'fs';
import path from 'path';
import ora from 'ora';
import packageJson from 'package-json';
import { gt } from 'semver';
import { getWorkspaces, spawnAsync } from './utils';

const {
    CI, GITHUB_EVENT_NAME, GITHUB_REF,
} = process.env;

const tag = GITHUB_REF === 'refs/heads/master' ? 'latest' : GITHUB_REF === 'refs/heads/develop' ? 'dev' : undefined;

if (CI && (!tag || GITHUB_EVENT_NAME !== 'push')) {
    console.log('publish skipped.');
    process.exit(0);
}

(async () => {
    let folders = await getWorkspaces();
    if (process.argv[2]) {
        folders = folders.filter((p) => p.startsWith(process.argv[2]));
    }

    const spinner = ora();
    const bumpMap = {};

    let progress = 0;
    spinner.start(`Loading workspaces (0/${folders.length})`);
    await Promise.all(folders.map(async (name) => {
        let meta;
        try {
            console.log('Loading package.json for:', name);

            const packagePath = path.resolve(__dirname, `../${name}/package.json`);
            console.log('Resolved path:', packagePath);

            meta = require(packagePath);

            if (!meta.private && /^[0-9.]+$/.test(meta.version)) {
                try {
                    const { version } = await packageJson(meta.name, { version: tag });
                    if (typeof version === 'string' && gt(meta.version, version)) {
                        bumpMap[name] = meta.version;
                    }
                } catch (e) {
                    if (e.name === 'VersionNotFoundError') {
                        bumpMap[name] = meta.version;
                    } else {
                        throw e;
                    }
                }
            }
        } catch (e) {
            console.error(`Error loading ${name}/package.json`, e);
        }
        spinner.text = `Loading workspaces (${++progress}/${folders.length})`;
    }));
    spinner.succeed();

    if (Object.keys(bumpMap).length) {
        for (const name in bumpMap) {
            console.log(`publishing ${name}@${bumpMap[name]} ...`);
            if (tag === 'dev') {
                const pkgPath = path.resolve(__dirname, `../${name}/package.json`);
                const pkg = require(pkgPath);
                pkg.version += '-dev';
                writeFileSync(pkgPath, JSON.stringify(pkg));
            }
            await spawnAsync(
                `yarn npm publish --access public --tag ${tag}`,
                path.resolve(__dirname, `../${name}`),
            );
        }
    }
    console.log('Release created successfully.');
})();
