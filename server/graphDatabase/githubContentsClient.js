// GithubContentsClient: a minimal wrapper over GitHub's Contents API
// (https://docs.github.com/en/rest/repos/contents) — the ONLY module that
// ever calls GitHub. Deliberately hand-rolled over Node's native fetch
// (Node 18+, already this project's minimum — see package.json's own
// engines field) rather than pulling in an SDK like octokit: three REST
// calls (read/write/delete one file) don't need a full client library,
// matching this project's own "a handful of routes don't need a
// framework" choice for server/api/app.js.
//
// Every method here either returns a plain result or throws — it never
// decides what a failure MEANS (retry? fall back to local storage?
// bubble up?) — that policy lives entirely in githubGraphDatabase.js, the
// only caller of this module. The one exception is getFile's own 404,
// which resolves to `null` rather than throwing: "this file doesn't
// exist yet" is an expected, first-class outcome (a brand-new graph, or
// an index.json that hasn't been created yet), not a failure.

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

const encodeContent = (text) => Buffer.from(text, 'utf8').toString('base64');
const decodeContent = (base64) => Buffer.from(base64, 'base64').toString('utf8');

/**
 * Builds a client bound to one repo/branch.
 *
 * @param {object} options
 * @param {string} options.token - a GitHub personal access token (or fine-grained token) with contents:write on this repo. Never logged, never returned from any method here.
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {string} options.branch
 * @param {typeof fetch} [options.fetchImpl] - injectable for tests, defaults to the global fetch.
 */
export const createGithubContentsClient = ({ token, owner, repo, branch, fetchImpl = fetch }) => {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  };
  const contentsUrl = (repoPath) => `${API_BASE}/repos/${owner}/${repo}/contents/${repoPath}`;

  return {
    /**
     * Reads one file's current content and sha (the sha is required to
     * update or delete it later — GitHub's own optimistic-concurrency
     * mechanism).
     *
     * @returns {Promise<{text: string, sha: string}|null>} null if the file doesn't exist (a 404) — never throws for that specific case.
     */
    async getFile(repoPath) {
      const res = await fetchImpl(`${contentsUrl(repoPath)}?ref=${encodeURIComponent(branch)}`, { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub getFile(${repoPath}) failed: ${res.status} ${res.statusText}`);
      const body = await res.json();
      return { text: decodeContent(body.content), sha: body.sha };
    },

    /**
     * Creates (no `sha`) or updates (with the file's current `sha`, from a
     * prior getFile) a file in one commit.
     *
     * @returns {Promise<string>} the file's new sha.
     */
    async putFile(repoPath, text, { sha, message } = {}) {
      const res = await fetchImpl(contentsUrl(repoPath), {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: message ?? `Update ${repoPath}`,
          content: encodeContent(text),
          branch,
          ...(sha ? { sha } : {}),
        }),
      });
      if (!res.ok) throw new Error(`GitHub putFile(${repoPath}) failed: ${res.status} ${res.statusText}`);
      const body = await res.json();
      return body.content.sha;
    },

    /**
     * Deletes a file. Looks up its current sha first if not provided.
     * A no-op (never throws) if the file is already gone.
     */
    async deleteFile(repoPath, { sha, message } = {}) {
      let fileSha = sha;
      if (!fileSha) {
        const existing = await this.getFile(repoPath);
        if (!existing) return;
        fileSha = existing.sha;
      }
      const res = await fetchImpl(contentsUrl(repoPath), {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message ?? `Delete ${repoPath}`, sha: fileSha, branch }),
      });
      if (!res.ok && res.status !== 404) throw new Error(`GitHub deleteFile(${repoPath}) failed: ${res.status} ${res.statusText}`);
    },
  };
};
