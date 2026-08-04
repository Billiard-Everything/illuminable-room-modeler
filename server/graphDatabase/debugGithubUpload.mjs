// debugGithubUpload.mjs — a standalone diagnostic for "why isn't anything
// showing up in the GitHub-backed graph repository". Saves one real test
// graph titled "debug-upload" straight through the real
// createGithubGraphDatabase/createGithubContentsClient code (the exact
// same modules the deployed app uses — nothing here is reimplemented),
// but with a fallback that THROWS instead of silently degrading to local
// storage: githubGraphDatabase.js's own local fallback (see its header
// comment) is exactly what makes a broken GitHub connection invisible
// from the outside in production — deliberately disabled here so the
// real failure surfaces instead of being swallowed.
//
// Usage — locally, with real credentials
// -----------------------------------------
//   Either export them first:
//     GITHUB_TOKEN=... GITHUB_OWNER=tasmiahjh-hash GITHUB_REPO=graph-database GITHUB_BRANCH=main \
//       node server/graphDatabase/debugGithubUpload.mjs
//   ...or put them in a local .env file (see .env.example) and just run:
//     node server/graphDatabase/debugGithubUpload.mjs
//   ...or, via the npm script alias:
//     npm run debug:github-upload
//
// Usage — against the deployed Render API instead of this script's own
// direct GitHub calls (proves the *deployed* server can reach GitHub, not
// just your local machine — Render's free tier has no shell access, so
// this is the practical way to "run this against Render"):
//
//   curl -X POST https://<your-render-service>.onrender.com/api/local-graphs \
//     -H "Content-Type: application/json" \
//     -d '{"params":{"sequenceText":"1 2 3","angleA":10,"angleB":20,"angleStepInput":"0.1","baseLength":50},"points":[{"a":1,"b":2},{"a":3,"b":4}],"title":"debug-upload"}'
//
//   Then check Render's own log viewer for the [graph-database]/
//   [github-graph-database]/[github-contents-client] lines this same code
//   prints there too (see graphDatabase.js/githubGraphDatabase.js/
//   githubContentsClient.js's own logging — added specifically so this
//   diagnosis doesn't require a special debug build).

import 'dotenv/config';
import { createGithubGraphDatabase } from './githubGraphDatabase.js';

const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = process.env;
const branch = GITHUB_BRANCH || 'main';

console.log('=== GitHub GraphDatabase upload diagnostic ===\n');
console.log('GITHUB_OWNER: ', GITHUB_OWNER ?? '(not set)');
console.log('GITHUB_REPO:  ', GITHUB_REPO ?? '(not set)');
console.log('GITHUB_BRANCH:', GITHUB_BRANCH ? GITHUB_BRANCH : '(not set — defaulting to "main")');
console.log('GITHUB_TOKEN: ', GITHUB_TOKEN ? `set (${GITHUB_TOKEN.length} characters, never printed)` : '(not set)');

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error('\nMissing one or more required env vars.');
  console.error('This is EXACTLY the condition under which the deployed app silently');
  console.error('falls back to local storage — see graphDatabase.js\'s own startup log');
  console.error('("[graph-database] GitHub-backed storage NOT configured..."). Set the');
  console.error('missing var(s) and re-run.');
  process.exit(1);
}

console.log('\n--- Step 1: confirm basic repo access (GET the repo itself) ---');
try {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const repoInfo = await res.json();
  if (!res.ok) {
    console.error(`FAILED (${res.status} ${res.statusText}):`, repoInfo.message ?? repoInfo);
    console.error('\nThis means the token/owner/repo combination is wrong before this script');
    console.error('ever gets to uploading anything. Check, in order:');
    console.error(`  1. The repository "${GITHUB_OWNER}/${GITHUB_REPO}" exists and is spelled exactly right (case matters).`);
    console.error('  2. The token has access to it: a classic PAT needs the "repo" scope; a');
    console.error('     fine-grained token needs this specific repo selected, with');
    console.error('     "Contents: Read and write" permission.');
    console.error('  3. If the repo belongs to an organization, the token/app has been');
    console.error('     approved for that organization (GitHub blocks fine-grained tokens');
    console.error('     from org repos until an admin approves them, even with correct scopes).');
    process.exit(1);
  }
  console.log(`OK — repo exists. default_branch="${repoInfo.default_branch}", private=${repoInfo.private}, permissions=${JSON.stringify(repoInfo.permissions ?? {})}`);
  if (repoInfo.permissions && repoInfo.permissions.push === false) {
    console.error('\nWARNING: this token has READ access to the repo but not WRITE (permissions.push is false).');
    console.error('Uploads will fail at the PUT step below no matter what else is correct.');
  }
} catch (err) {
  console.error('FAILED — could not even reach api.github.com:', err.message);
  process.exit(1);
}

console.log('\n--- Step 2: save a graph titled "debug-upload" through the real save path ---');
// A fallback that throws instead of silently degrading to local storage —
// see this file's own header comment on why: the whole point of this
// script is to see the REAL GitHub failure, not the resilient production
// behavior that's specifically designed to hide it.
const noSilentFallback = {
  saveGraph() { throw new Error('GitHub save failed — see the [github-contents-client] request/response logs above for the real error, and Step 1\'s own diagnosis for the most likely cause.'); },
};

const db = createGithubGraphDatabase({
  token: GITHUB_TOKEN, owner: GITHUB_OWNER, repo: GITHUB_REPO, branch, fallback: noSilentFallback,
});

const testParams = { sequenceText: '1 2 3', angleA: 10, angleB: 20, angleStepInput: '0.1', baseLength: 50 };
let saved;
try {
  saved = await db.saveGraph({
    params: testParams, points: [{ a: 1, b: 2 }, { a: 3, b: 4 }], title: 'debug-upload', author: 'debug-script',
  });
  console.log('\n=== SAVE SUCCEEDED ===');
  console.log('Saved graph id:  ', saved.id);
  console.log('Saved graph hash:', saved.hash);
  console.log('\nVerify in your browser:');
  console.log(`  https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tree/${branch}/graphs/${saved.id}`);
  console.log(`  https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/blob/${branch}/database/index.json`);
} catch (err) {
  console.error('\n=== SAVE FAILED ===');
  console.error(err.message);
  process.exit(1);
}

console.log('\n--- Step 3: confirm loadGraph reads it straight back, with no recomputation ---');
try {
  const loaded = await db.loadGraph(saved.hash);
  if (!loaded) throw new Error('loadGraph returned null right after a successful save — the index.json write may not have landed.');
  if (loaded.id !== saved.id || loaded.points.length !== saved.points.length) {
    throw new Error(`loadGraph returned a different graph than what was just saved (id ${loaded.id} vs ${saved.id}).`);
  }
  console.log(`OK — loadGraph read back ${loaded.points.length} points and title "${loaded.metadata.title}" straight from GitHub.`);
  console.log('\n=== ALL CHECKS PASSED — the GitHub upload path is working. ===');
} catch (err) {
  console.error('\n=== LOAD-BACK FAILED (the save above worked, but reading it back did not) ===');
  console.error(err.message);
  process.exit(1);
}
