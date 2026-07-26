import child from 'child_process';
import path from 'path';
import { CAC } from 'cac';
import { Logger } from '@ejunz/utils';

const logger = new Logger('embedding');
const ejunBin = path.resolve(__dirname, '../../bin/ejun.js');

function runCliScript(scriptName: string, payload: Record<string, unknown>) {
    const args = [
        ejunBin,
        'cli',
        'script',
        scriptName,
        JSON.stringify(payload),
    ];
    logger.info('Running: node %s', args.join(' '));
    const res = child.spawnSync(process.execPath, args, {
        stdio: 'inherit',
        env: process.env,
    });
    process.exit(res.status ?? 1);
}

export function register(cli: CAC) {
    cli.command('embedding <action> <domainId> <baseDocId>', 'Embedding index tools (reindex|status)')
        .action((action: string, domainId: string, baseDocIdRaw: string) => {
            const baseDocId = Number(baseDocIdRaw);
            if (!String(domainId || '').trim() || !Number.isFinite(baseDocId) || baseDocId <= 0) {
                logger.error('Usage: ejun embedding <reindex|status> <domainId> <baseDocId>');
                process.exit(1);
            }
            const domain = String(domainId).trim();
            if (action === 'reindex') {
                runCliScript('embeddingReindex', {
                    domainId: domain,
                    baseDocId,
                    mode: 'full_rebuild',
                    reason: 'cli',
                });
                return;
            }
            if (action === 'status') {
                runCliScript('embeddingStatus', {
                    domainId: domain,
                    baseDocId,
                });
                return;
            }
            logger.error('Unknown action %s. Use reindex or status.', action);
            process.exit(1);
        });
}
