// The REST v3 surface: /api/v3 routes over the forge model. Every handler
// returns {status, body, headers?} or throws ForgeError, which the server
// turns into GitHub's {message} error body.

import { ForgeError, VIEWER, commitFile, flattenTree, commitTree, mergePull, pullFiles, pullMergeability } from './forge.ts';
import type { Forge, Repo } from './forge.ts';
import { branchJson, commentJson, commitJson, contentsJson, issueJson, labelJson, pullJson, repoJson, userJson } from './serializers.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Json = Record<string, unknown>;

function bodyOf(body: unknown): Json {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Json) : {};
}

function str(body: Json, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function repoOr404(forge: Forge, owner: string, name: string): Repo {
  const repo = forge.getRepo(owner, name);
  if (repo === null) throw new ForgeError(404, 'Not Found');
  return repo;
}

/** Slice one page and build the Link header GitHub paginates with. */
function paginate<T>(items: T[], query: URLSearchParams, urlForPage: (page: number, perPage: number) => string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  if (page < lastPage) {
    const links = [`<${urlForPage(page + 1, perPage)}>; rel="next"`, `<${urlForPage(lastPage, perPage)}>; rel="last"`];
    if (page > 1) links.push(`<${urlForPage(page - 1, perPage)}>; rel="prev"`, `<${urlForPage(1, perPage)}>; rel="first"`);
    headers.link = links.join(', ');
  }
  return { page: slice, headers };
}

export function routeRest(forge: Forge, method: string, segments: string[], query: URLSearchParams, body: unknown, origin: string): RestResult {
  const [a, b, c, d, e, ...rest] = segments;
  const json = bodyOf(body);

  if (segments.length === 0 && method === 'GET') {
    return { status: 200, body: { current_user_url: '/api/v3/user', current_user_repositories_url: '/api/v3/user/repos', rate_limit_url: '/api/v3/rate_limit' } };
  }
  if (a === 'meta' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0-makefun-forge', verifiable_password_authentication: false } };
  }
  if (a === 'user' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: userJson(VIEWER) };
  }
  if (a === 'user' && b === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const { page, headers } = paginate(forge.listRepos(), query, (p, pp) => `${origin}/api/v3/user/repos?page=${p}&per_page=${pp}`);
      return { status: 200, body: page.map(repoJson), headers };
    }
    if (method === 'POST') {
      const name = str(json, 'name');
      if (name === undefined || name === '') throw new ForgeError(422, 'name is required');
      const repo = forge.createRepo(name, str(json, 'description') ?? '', json.private === true);
      return { status: 201, body: repoJson(repo) };
    }
  }

  if (a === 'repos' && b !== undefined && c !== undefined) {
    const repo = repoOr404(forge, b, c);
    const base = `/repos/${b}/${c}`;

    if (segments.length === 3) {
      if (method === 'GET') return { status: 200, body: repoJson(repo) };
      if (method === 'PATCH') {
        if (str(json, 'description') !== undefined) repo.description = str(json, 'description')!;
        if (typeof json.private === 'boolean') repo.isPrivate = json.private;
        if (str(json, 'name') !== undefined && str(json, 'name') !== repo.name) throw new ForgeError(422, 'name changes are not supported');
        return { status: 200, body: repoJson(repo) };
      }
      if (method === 'DELETE') {
        forge.deleteRepo(b, c);
        return { status: 204 };
      }
    }

    if (d === 'branches') {
      if (segments.length === 4 && method === 'GET') {
        const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length)).sort();
        return { status: 200, body: names.map((name) => branchJson(repo, name)) };
      }
      if (segments.length >= 5 && method === 'GET') {
        const name = [e, ...rest].join('/');
        if (repo.branchTip(name) === null) throw new ForgeError(404, 'Branch not found');
        return { status: 200, body: branchJson(repo, name) };
      }
    }

    if (d === 'commits' && segments.length === 4 && method === 'GET') {
      const shaParam = query.get('sha');
      let tip: string | null;
      if (shaParam === null || shaParam === '') tip = repo.branchTip(repo.defaultBranch);
      else if (/^[0-9a-f]{40}$/.test(shaParam)) tip = repo.store.has(shaParam) ? shaParam : null;
      else tip = repo.branchTip(shaParam);
      if (tip === null) return { status: 200, body: [] };
      const seen = new Set<string>();
      const ordered: string[] = [];
      const queue = [tip];
      while (queue.length > 0) {
        const sha = queue.shift()!;
        if (seen.has(sha)) continue;
        seen.add(sha);
        const parsed = repo.store.parseCommit(sha);
        if (!parsed) continue;
        ordered.push(sha);
        queue.push(...parsed.parents);
      }
      const { page, headers } = paginate(ordered, query, (p, pp) => `${origin}/api/v3${base}/commits?page=${p}&per_page=${pp}`);
      return { status: 200, body: page.map((sha) => commitJson(repo, sha)), headers };
    }

    if (d === 'git' && e === 'refs') {
      if (segments.length === 5 && method === 'POST') {
        const ref = str(json, 'ref');
        const sha = str(json, 'sha');
        if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) throw new ForgeError(422, 'ref and sha are required');
        if (!repo.store.has(sha)) throw new ForgeError(422, `Object ${sha} does not exist`);
        if (repo.refs.has(ref)) throw new ForgeError(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        const type = repo.store.get(sha)?.type ?? 'commit';
        return { status: 201, body: { ref, node_id: '', object: { sha, type, url: '' } } };
      }
      if (segments.length >= 6 && method === 'GET') {
        const ref = `refs/${[e === 'refs' ? segments[5] : e, ...rest].join('/')}`;
        const fullRef = `refs/${segments.slice(5).join('/')}`;
        void ref;
        const sha = repo.refs.get(fullRef);
        if (sha === undefined) throw new ForgeError(404, 'Reference not found');
        return { status: 200, body: { ref: fullRef, node_id: '', object: { sha, type: repo.store.get(sha)?.type ?? 'commit', url: '' } } };
      }
    }

    if (d === 'contents') {
      const path = segments.slice(4).join('/');
      if (method === 'GET') {
        const found = contentsJson(repo, path, query.get('ref'));
        if (found === null) throw new ForgeError(404, 'Not Found');
        return { status: 200, body: found };
      }
      if (method === 'PUT') {
        const message = str(json, 'message') ?? 'Update file';
        const contentB64 = str(json, 'content');
        if (contentB64 === undefined) throw new ForgeError(422, 'content is required');
        const branch = str(json, 'branch') ?? repo.defaultBranch;
        const tip = repo.branchTip(branch);
        const flat = flattenTree(repo.store, commitTree(repo.store, tip));
        const existing = flat.get(path);
        const suppliedSha = str(json, 'sha');
        if (existing !== undefined) {
          if (suppliedSha === undefined) throw new ForgeError(422, '"sha" wasn\'t supplied.');
          if (suppliedSha.toLowerCase() !== existing.sha.toLowerCase()) throw new ForgeError(409, `${path} does not match ${suppliedSha}`);
        }
        const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const { commitSha, blobSha } = commitFile(forge, repo, { branch, path, content, message });
        return {
          status: existing !== undefined ? 200 : 201,
          body: {
            content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
            commit: { sha: commitSha, message },
          },
        };
      }
      if (method === 'DELETE') {
        const branch = str(json, 'branch') ?? repo.defaultBranch;
        const tip = repo.branchTip(branch);
        const flat = flattenTree(repo.store, commitTree(repo.store, tip));
        const existing = flat.get(path);
        if (existing === undefined) throw new ForgeError(404, 'Not Found');
        const suppliedSha = str(json, 'sha');
        if (suppliedSha !== undefined && suppliedSha.toLowerCase() !== existing.sha.toLowerCase()) throw new ForgeError(409, `${path} does not match ${suppliedSha}`);
        const { commitSha } = commitFile(forge, repo, { branch, path, content: null, message: str(json, 'message') ?? 'Delete file' });
        return { status: 200, body: { content: null, commit: { sha: commitSha } } };
      }
    }

    if (d === 'labels' && segments.length === 4) {
      if (method === 'GET') return { status: 200, body: [...repo.labels.keys()].map((name) => labelJson(repo, name)) };
      if (method === 'POST') {
        const name = str(json, 'name');
        if (name === undefined || name === '') throw new ForgeError(422, 'name is required');
        if (repo.labels.has(name)) throw new ForgeError(422, 'Label already exists');
        repo.labels.set(name, { name, color: str(json, 'color') ?? 'ededed', description: str(json, 'description') ?? '' });
        return { status: 201, body: labelJson(repo, name) };
      }
    }

    if (d === 'issues') {
      if (segments.length === 4) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const direction = query.get('direction') ?? 'desc';
          let issues = [...repo.issues.values()];
          if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
          else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
          issues.sort((x, y) => (direction === 'asc' ? x.seq - y.seq : y.seq - x.seq));
          const { page, headers } = paginate(issues, query, (p, pp) => `${origin}/api/v3${base}/issues?page=${p}&per_page=${pp}`);
          return { status: 200, body: page.map((issue) => issueJson(repo, issue)), headers };
        }
        if (method === 'POST') {
          const title = str(json, 'title');
          if (title === undefined || title === '') throw new ForgeError(422, 'title is required');
          const labels = Array.isArray(json.labels) ? json.labels.filter((x): x is string => typeof x === 'string') : undefined;
          const issue = forge.createIssue(repo, { title, body: str(json, 'body') ?? '', labels });
          return { status: 201, body: issueJson(repo, issue) };
        }
      }
      const number = Number(d === 'issues' ? e : NaN);
      if (segments.length >= 5 && Number.isInteger(number)) {
        const issue = repo.issues.get(number);
        if (issue === undefined) throw new ForgeError(404, 'Not Found');
        if (segments.length === 5) {
          if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
          if (method === 'PATCH') {
            if (str(json, 'state') === 'closed' || str(json, 'state') === 'open') issue.state = str(json, 'state') as 'open' | 'closed';
            if (str(json, 'title') !== undefined) issue.title = str(json, 'title')!;
            if (str(json, 'body') !== undefined) issue.body = str(json, 'body')!;
            if (Array.isArray(json.labels)) {
              const labels = json.labels.filter((x): x is string => typeof x === 'string');
              for (const name of labels) if (!repo.labels.has(name)) throw new ForgeError(422, `Label '${name}' does not exist`);
              issue.labels = labels;
            }
            return { status: 200, body: issueJson(repo, issue) };
          }
        }
        if (segments.length === 6 && segments[5] === 'comments') {
          if (method === 'GET') return { status: 200, body: issue.comments.map(commentJson) };
          if (method === 'POST') {
            const commentBody = str(json, 'body');
            if (commentBody === undefined) throw new ForgeError(422, 'body is required');
            const comment = forge.addComment(repo, issue, commentBody);
            return { status: 201, body: commentJson(comment) };
          }
        }
      }
    }

    if (d === 'pulls') {
      if (segments.length === 4) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
          else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
          pulls.sort((x, y) => y.seq - x.seq);
          const { page, headers } = paginate(pulls, query, (p, pp) => `${origin}/api/v3${base}/pulls?page=${p}&per_page=${pp}`);
          return { status: 200, body: page.map((pull) => pullJson(repo, pull)), headers };
        }
        if (method === 'POST') {
          const title = str(json, 'title');
          const headRaw = str(json, 'head');
          const baseRaw = str(json, 'base');
          if (title === undefined || headRaw === undefined || baseRaw === undefined) throw new ForgeError(422, 'title, head and base are required');
          const branchOf = (value: string): string => (value.includes(':') ? value.split(':').pop()! : value);
          const pull = forge.createPull(repo, { title, body: str(json, 'body') ?? '', head: branchOf(headRaw), base: branchOf(baseRaw) });
          return { status: 201, body: pullJson(repo, pull) };
        }
      }
      const number = Number(e);
      if (segments.length >= 5 && Number.isInteger(number)) {
        const pull = repo.pulls.get(number);
        if (segments.length === 5 && method === 'GET') {
          if (pull === undefined) throw new ForgeError(404, 'Not Found');
          return { status: 200, body: pullJson(repo, pull) };
        }
        if (pull === undefined) throw new ForgeError(404, 'Not Found');
        if (segments.length === 6 && segments[5] === 'files' && method === 'GET') {
          const files = pullFiles(repo, pull).map((file) => ({
            sha: '',
            filename: file.path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
          }));
          return { status: 200, body: files };
        }
        if (segments.length === 6 && segments[5] === 'merge' && method === 'PUT') {
          if (pull.state !== 'open') throw new ForgeError(405, 'Pull Request is not mergeable');
          const methodName = str(json, 'merge_method') ?? 'merge';
          const { mergeable } = pullMergeability(repo, pull);
          if (mergeable !== 'MERGEABLE') throw new ForgeError(405, 'Pull Request is not mergeable');
          const { sha } = mergePull(forge, repo, pull, methodName === 'squash' ? 'squash' : methodName === 'rebase' ? 'rebase' : 'merge');
          return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
        }
      }
    }
  }

  throw new ForgeError(404, 'Not Found');
}
