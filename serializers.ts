// The JSON shapes the surfaces answer with. REST is the reference shape;
// MCP returns the same objects, and GraphQL maps them onto its own types.

import { parseTree } from './gitstore.ts';
import type { Comment, Issue, Pull, Repo, User } from './forge.ts';
import { commitTree, flattenTree } from './forge.ts';

export function userJson(user: User): Record<string, unknown> {
  return { id: user.id, login: user.login, name: user.name, email: user.email, type: 'User', site_admin: false };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    html_url: `https://github.example/${repo.fullName}`,
    url: `https://api.github.example/repos/${repo.fullName}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-01-01T00:00:00Z',
  };
}

export function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: repo.id * 1000 + [...repo.labels.keys()].indexOf(name) + 1,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
    default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(issue.author),
    author: userJson(issue.author),
    comments: issue.comments.length,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: issue.state === 'closed' ? '2026-01-01T00:00:00Z' : null,
    html_url: `https://github.example/${repo.fullName}/issues/${issue.number}`,
  };
}

export function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', String(comment.id)),
    body: comment.body,
    user: userJson(comment.author),
    author: userJson(comment.author),
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function identLine(store: Repo['store'], commitSha: string): { author: Record<string, unknown>; committer: Record<string, unknown>; message: string; tree: string; parents: string[] } {
  const obj = store.get(commitSha);
  const text = obj?.content.toString('utf8') ?? '';
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2).replace(/\n$/, '');
  const parse = (line: string | undefined): Record<string, unknown> => {
    const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line ?? '');
    if (!match) return { name: '', email: '', date: '2026-01-01T00:00:00Z' };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  let author: Record<string, unknown> = { name: '', email: '', date: '2026-01-01T00:00:00Z' };
  let committer = author;
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('author ')) author = parse(line.slice(7));
    else if (line.startsWith('committer ')) committer = parse(line.slice(10));
    else if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { author, committer, message, tree, parents };
}

export function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const parsed = identLine(repo.store, sha);
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      message: parsed.message,
      author: parsed.author,
      committer: parsed.committer,
      tree: { sha: parsed.tree },
    },
    author: null,
    committer: null,
    parents: parsed.parents.map((parent) => ({ sha: parent })),
  };
}

export function branchJson(repo: Repo, name: string): Record<string, unknown> {
  const sha = repo.branchTip(name) ?? '';
  return { name, commit: { sha, ...commitSummary(repo, sha) }, protected: false };
}

function commitSummary(repo: Repo, sha: string): Record<string, unknown> {
  if (sha === '') return {};
  const parsed = identLine(repo.store, sha);
  return { message: parsed.message };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseSha = repo.branchTip(pull.baseRef) ?? '';
  const side = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner.login}:${ref}`,
    ref,
    sha,
    user: userJson(repo.owner),
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: side(pull.headRef, headSha),
    base: side(pull.baseRef, baseSha),
    user: userJson(pull.author),
    author: userJson(pull.author),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    html_url: `https://github.example/${repo.fullName}/pull/${pull.number}`,
  };
}

/** The contents API's view of one path at one ref: a file object or a directory listing. */
export function contentsJson(repo: Repo, path: string, ref: string | null): Record<string, unknown> | unknown[] | null {
  const tip = ref === null ? repo.branchTip(repo.defaultBranch) : repo.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`) ?? repo.branchTip(ref);
  const flat = flattenTree(repo.store, commitTree(repo.store, tip));
  const file = flat.get(path);
  if (file !== undefined) {
    const blob = repo.store.get(file.sha);
    const content = blob?.content ?? Buffer.alloc(0);
    return {
      type: 'file',
      name: path.split('/').pop() ?? path,
      path,
      sha: file.sha,
      size: content.length,
      encoding: 'base64',
      content: content.toString('base64').replace(/(.{60})/g, '$1\n'),
    };
  }
  // A directory: the entries directly under path ('' is the root).
  const prefix = path === '' ? '' : `${path}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
  for (const [candidate, entry] of flat) {
    if (!candidate.startsWith(prefix)) continue;
    const rest = candidate.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      entries.set(rest, { type: 'file', sha: entry.sha, size: repo.store.get(entry.sha)?.content.length ?? 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!entries.has(dir)) {
        // The directory's own tree id: walk the root tree down to it.
        const dirSha = treeAtPath(repo, tip, prefix + dir);
        entries.set(dir, { type: 'dir', sha: dirSha ?? entry.sha, size: 0 });
      }
    }
  }
  if (entries.size === 0 && path !== '') return null;
  return [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, entry]) => ({ type: entry.type, name, path: prefix + name, sha: entry.sha, size: entry.size }));
}

/** The tree id at a directory path inside a commit (for directory listings). */
function treeAtPath(repo: Repo, commitSha: string | null, dirPath: string): string | null {
  let tree = commitTree(repo.store, commitSha);
  if (tree === null) return null;
  for (const segment of dirPath.split('/').filter(Boolean)) {
    const obj = repo.store.get(tree);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.content).find((candidate) => candidate.name === segment);
    if (!entry) return null;
    tree = entry.sha;
  }
  return tree;
}

/** Relay-style global ids: opaque, stable, and decodable by node(id:) and the mutations. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}
