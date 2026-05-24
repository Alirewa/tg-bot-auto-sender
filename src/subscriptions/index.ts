import * as fs from 'fs';
import * as path from 'path';
import { ValidatedConfig } from '../types';
import { generateSubFiles, SubFiles } from './generator';
import logger from '../utils/logger';
import type { GitHubPublisher } from '../github';

export type { SubFiles };

export interface SubsOptions {
  subsDir: string;
  githubPublisher?: GitHubPublisher;
}

/**
 * Generates all subscription files from the supplied alive configs and writes
 * them to disk. If a GitHubPublisher is provided it is called after writing
 * so the files are also pushed to the remote repository.
 *
 * All errors are caught internally so a GitHub outage or a disk permission
 * issue never crashes the scrape cycle.
 */
export async function generateAndWriteSubs(
  configs: ValidatedConfig[],
  opts: SubsOptions,
): Promise<void> {
  if (configs.length === 0) {
    logger.debug('subscriptions: no alive configs, skipping generation');
    return;
  }

  const { subsDir, githubPublisher } = opts;

  // 1. Generate sub file contents (pure transform, no I/O).
  const files = generateSubFiles(configs);

  // 2. Write to disk.
  try {
    fs.mkdirSync(subsDir, { recursive: true });

    for (const [key, content] of Object.entries(files) as [keyof SubFiles, string][]) {
      const filePath = path.join(subsDir, `${key}.txt`);
      fs.writeFileSync(filePath, content, 'utf-8');
      logger.debug('subscriptions: wrote', {
        file: `${key}.txt`,
        bytes: Buffer.byteLength(content, 'utf-8'),
      });
    }

    logger.info('subscriptions: generated', {
      dir: subsDir,
      totalConfigs: configs.length,
      protocols: {
        vmess: files.vmess.split('\n').filter(Boolean).length,
        vless: files.vless.split('\n').filter(Boolean).length,
        trojan: files.trojan.split('\n').filter(Boolean).length,
        ss: files.ss.split('\n').filter(Boolean).length,
        wireguard: files.wireguard.split('\n').filter(Boolean).length,
      },
    });
  } catch (err) {
    logger.error('subscriptions: failed to write files', {
      subsDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return; // don't attempt GitHub push if disk write failed
  }

  // 3. Push to GitHub (if configured).
  if (githubPublisher) {
    try {
      await githubPublisher.pushAll(files);
    } catch (err) {
      logger.error('subscriptions: GitHub push failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
