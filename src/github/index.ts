import axios, { AxiosError } from 'axios';
import config from '../utils/config';
import logger from '../utils/logger';
import type { SubFiles } from '../subscriptions';

interface GitHubConfig {
  token: string;
  repo: string;    // "owner/repo"
  branch: string;
  subDir: string;  // subdirectory inside the repo
  pushIntervalMs: number;
}

/** Order in which files are pushed (sequential to respect GitHub's secondary rate limit). */
const FILE_KEYS: Array<keyof SubFiles> = [
  'main',
  'healthy',
  'vless',
  'vmess',
  'trojan',
  'ss',
  'wireguard',
];

export class GitHubPublisher {
  private lastPushAt = 0;
  private readonly apiBase = 'https://api.github.com';

  constructor(private readonly cfg: GitHubConfig) {}

  /**
   * Push all sub files to GitHub.
   * Rate-limited: if the last push was less than `pushIntervalMs` ago, this call
   * is silently skipped.
   */
  async pushAll(files: SubFiles): Promise<void> {
    const now = Date.now();
    if (now - this.lastPushAt < this.cfg.pushIntervalMs) {
      logger.debug('github: push skipped (rate limit)', {
        nextPushIn: Math.round((this.cfg.pushIntervalMs - (now - this.lastPushAt)) / 1000) + 's',
      });
      return;
    }

    logger.info('github: pushing subscription files', { repo: this.cfg.repo });

    let pushed = 0;
    for (const key of FILE_KEYS) {
      const filePath = `${this.cfg.subDir}/${key}.txt`;
      try {
        await this.updateFile(filePath, files[key]);
        pushed++;
        // Brief pause between writes to respect GitHub's secondary rate limit (~1 write/s).
        await sleep(1100);
      } catch (err) {
        logger.error('github: failed to push file', {
          file: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue pushing remaining files even if one fails.
      }
    }

    this.lastPushAt = Date.now();
    logger.info('github: push complete', { pushed, total: FILE_KEYS.length });
  }

  /** Creates or updates a single file in the GitHub repository. */
  private async updateFile(filePath: string, content: string): Promise<void> {
    const apiPath = `/repos/${this.cfg.repo}/contents/${filePath}`;
    const sha = await this.getFileSha(apiPath);

    // GitHub Contents API requires base64-encoded content.
    const encoded = Buffer.from(content, 'utf-8').toString('base64');

    const body: Record<string, unknown> = {
      message: `chore: update ${filePath}`,
      content: encoded,
      branch: this.cfg.branch,
    };
    if (sha) body['sha'] = sha;

    await axios.put(`${this.apiBase}${apiPath}`, body, {
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 15_000,
    });

    logger.debug('github: file updated', { filePath });
  }

  /** Fetches the current SHA of a file (needed to update it). Returns undefined if not found. */
  private async getFileSha(apiPath: string): Promise<string | undefined> {
    try {
      const res = await axios.get(`${this.apiBase}${apiPath}`, {
        params: { ref: this.cfg.branch },
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        timeout: 10_000,
      });
      return (res.data as { sha: string }).sha;
    } catch (err) {
      const axiosErr = err as AxiosError;
      if (axiosErr.response?.status === 404) return undefined; // file doesn't exist yet
      throw err;
    }
  }
}

/** Singleton instance — created lazily the first time it is requested. */
let instance: GitHubPublisher | undefined;

/**
 * Returns the GitHubPublisher singleton if GITHUB_TOKEN and GITHUB_REPO are
 * configured, otherwise returns undefined (GitHub publishing is disabled).
 */
export function getGithubPublisher(): GitHubPublisher | undefined {
  if (!config.githubToken || !config.githubRepo) return undefined;

  if (!instance) {
    instance = new GitHubPublisher({
      token: config.githubToken,
      repo: config.githubRepo,
      branch: config.githubBranch,
      subDir: config.subDir,
      pushIntervalMs: config.githubPushIntervalMs,
    });
    logger.info('github: publisher initialized', {
      repo: config.githubRepo,
      branch: config.githubBranch,
      subDir: config.subDir,
    });
  }

  return instance;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
