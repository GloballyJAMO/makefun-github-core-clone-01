// The forge's data model: users, repositories, and everything that lives in
// one — a git object store, refs, labels, issues, pull requests, comments.
// REST, GraphQL and MCP are three views over this one model, so an object
// created through any of them reads identically through the others.

import { ObjectStore, buildTree, parseTree, type GitObjectType } from './gitstore.ts';

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The trial's cast. The bearer token belongs to the viewer; the others exist so ownership checks have someone to be. */
export const VIEWER: User = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const TEAMMATE: User = { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' };
export const STRANGER: User = { id: 1002, login: 'olgabauer', name: 'olgabauer', email: 'olgabauer@example.invalid' };
export const USERS: readonly User[] = [VIEWER, TEAMMATE, STRANGER];

export interface Label {
  readonly name: string;
  color: string;
  description: string;
}

export interface Comment {
  readonly id: number;
  body: string;
  readonly author: User;
  readonly seq: number;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly comments: Comment[];
  readonly author: User;
  readonly seq: number;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  readonly author: User;
  readonly seq: number;
}

export class Repo {
  readonly store = new ObjectStore();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, Pull>();
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber = 1;
  defaultBranch = 'main';

  readonly id: number;
  readonly owner: User;
  readonly name: string;
  description: string;
  isPrivate: boolean;

  constructor(id: number, owner: User, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
  }

  get fullName(): string {
    return `${this.owner.login}/${this.name}`;
  }

  /** The commit a branch ref points at, or null when the branch is unborn/absent. */
  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  headTarget(): string {
    return `refs/heads/${this.defaultBranch}`;
  }
}

/** An error that maps straight onto an HTTP status and a {message} body. */
export class ForgeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ForgeError';
    this.status = status;
  }
}

const CLOCK_START = 1_760_000_000;

export class Forge {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 5000;
  private issueSeq = 1;
  private commentSeq = 1;
  private seq = 0;
  private clock = CLOCK_START;

  /** A monotone sequence number: creation order that no wall clock can disturb. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Deterministic timestamps for commits this forge authors itself. */
  nextTimestamp(): number {
    this.clock += 60;
    return this.clock;
  }

  identity(): string {
    return `${VIEWER.name} <${VIEWER.email}>`;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const key = `${VIEWER.login}/${name}`;
    if (this.repos.has(key)) throw new ForgeError(422, 'name already exists on this account');
    const repo = new Repo(this.repoSeq++, VIEWER, name, description, isPrivate);
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  /** Only the viewer's own repositories are ever listed or visible. */
  listRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner.login === VIEWER.login).sort((a, b) => a.id - b.id);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  createIssue(repo: Repo, input: { title: string; body: string; labels?: string[] }): Issue {
    for (const name of input.labels ?? []) {
      if (!repo.labels.has(name)) throw new ForgeError(422, `Label '${name}' does not exist in this repository`);
    }
    const issue: Issue = {
      id: this.issueSeq++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...(input.labels ?? [])],
      comments: [],
      author: VIEWER,
      seq: this.nextSeq(),
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    void repo;
    const comment: Comment = { id: this.commentSeq++, body, author: VIEWER, seq: this.nextSeq() };
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, input: { title: string; body: string; head: string; base: string }): Pull {
    const headSha = repo.branchTip(input.head);
    if (headSha === null) throw new ForgeError(422, `Head ref '${input.head}' does not exist`);
    if (repo.branchTip(input.base) === null && repo.refs.size > 0) throw new ForgeError(422, `Base ref '${input.base}' does not exist`);
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base) {
        throw new ForgeError(422, `A pull request already exists for ${input.head} into ${input.base}`);
      }
    }
    const pull: Pull = {
      id: this.issueSeq++,
      number: repo.nextNumber++,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      headRef: input.head,
      baseRef: input.base,
      headSha,
      mergeCommitSha: null,
      mergedAt: null,
      author: VIEWER,
      seq: this.nextSeq(),
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }
}

// ---------------------------------------------------------------------------
// git plumbing over a repo's store
// ---------------------------------------------------------------------------

/** Flatten a tree into path -> {sha, mode}, recursively. */
export function flattenTree(store: ObjectStore, treeSha: string | null, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  if (treeSha === null) return out;
  const obj = store.get(treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.content)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** Build (and store) a tree from a flat path -> blob map; returns the tree id. */
export function treeFromFlat(store: ObjectStore, flat: Map<string, { sha: string; mode: string }>): string {
  interface Node {
    files: Map<string, { sha: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], { files: new Map(), dirs: new Map() });
      node = node.dirs.get(segments[i])!;
    }
    node.files.set(segments[segments.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries = [
      ...[...node.files.entries()].map(([name, entry]) => ({ mode: entry.mode, name, sha: entry.sha })),
      ...[...node.dirs.entries()].map(([name, child]) => ({ mode: '40000', name, sha: build(child) })),
    ];
    // git sorts tree entries itself; buildTree here is the raw writer, so sort the git way.
    entries.sort((a, b) => {
      const ka = a.mode === '40000' ? `${a.name}/` : a.name;
      const kb = b.mode === '40000' ? `${b.name}/` : b.name;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

/** The tree of a commit (empty-tree id when the commit is unknown). */
export function commitTree(store: ObjectStore, commitSha: string | null): string | null {
  if (commitSha === null) return null;
  return store.parseCommit(commitSha)?.tree ?? null;
}

/** Store a blob and return its id. */
export function putBlob(store: ObjectStore, content: Buffer): string {
  return store.put('blob', content);
}

/** Author a commit in the store with the forge's identity and clock. */
export function makeCommit(
  forge: Forge,
  store: ObjectStore,
  input: { tree: string; parents: string[]; message: string },
): string {
  const stamp = forge.nextTimestamp();
  const who = `${forge.identity()} ${stamp} +0000`;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return store.put('commit', Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8'));
}

/**
 * Commit a single-file change on a branch (the contents API's write). The
 * branch is created when it does not exist yet: from the default branch's
 * tip, or as a root commit in an empty repository.
 */
export function commitFile(
  forge: Forge,
  repo: Repo,
  input: { branch: string; path: string; content: Buffer | null; message: string },
): { commitSha: string; blobSha: string | null } {
  const ref = `refs/heads/${input.branch}`;
  let tip = repo.refs.get(ref) ?? null;
  if (tip === null && input.branch !== repo.defaultBranch) {
    tip = repo.branchTip(repo.defaultBranch);
  }
  const flat = flattenTree(repo.store, commitTree(repo.store, tip));
  let blobSha: string | null = null;
  if (input.content === null) {
    flat.delete(input.path);
  } else {
    blobSha = putBlob(repo.store, input.content);
    flat.set(input.path, { sha: blobSha, mode: '100644' });
  }
  const tree = treeFromFlat(repo.store, flat);
  const commitSha = makeCommit(forge, repo.store, {
    tree,
    parents: tip === null ? [] : [tip],
    message: input.message,
  });
  repo.refs.set(ref, commitSha);
  return { commitSha, blobSha };
}

/** Every ancestor of a commit, itself included (breadth-first). */
export function ancestors(store: ObjectStore, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    const parsed = store.parseCommit(sha);
    if (!parsed) continue;
    seen.add(sha);
    queue.push(...parsed.parents);
  }
  return seen;
}

export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  return ancestors(store, descendant).has(ancestor);
}

/** The best common ancestor of two commits, or null when unrelated. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const fromA = ancestors(store, a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (fromA.has(sha)) return sha;
    const parsed = store.parseCommit(sha);
    if (parsed) queue.push(...parsed.parents);
  }
  return null;
}

export interface MergeOutcome {
  tree: string;
  conflict: boolean;
}

/**
 * A file-level three-way merge of two trees against their base. A path
 * conflicts when both sides changed it differently (or one deleted what
 * the other changed); everything else resolves to the changed side.
 */
export function threeWayMerge(store: ObjectStore, baseTree: string | null, ourTree: string | null, theirTree: string | null): MergeOutcome {
  const base = flattenTree(store, baseTree);
  const ours = flattenTree(store, ourTree);
  const theirs = flattenTree(store, theirTree);
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const out = new Map<string, { sha: string; mode: string }>();
  let conflict = false;
  for (const path of paths) {
    const b = base.get(path)?.sha;
    const o = ours.get(path)?.sha;
    const t = theirs.get(path)?.sha;
    if (o === t) {
      if (o !== undefined) out.set(path, ours.get(path)!);
    } else if (b === o) {
      if (t !== undefined) out.set(path, theirs.get(path)!);
    } else if (b === t) {
      if (o !== undefined) out.set(path, ours.get(path)!);
    } else {
      conflict = true;
    }
  }
  return { tree: treeFromFlat(store, out), conflict };
}

/** Whether merging `head` into `base` would conflict (or the base tip when it applies cleanly). */
export function pullMergeability(repo: Repo, pull: Pull): { mergeable: 'MERGEABLE' | 'CONFLICTING'; baseTip: string | null; headTip: string | null; outcome: MergeOutcome | null } {
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  if (baseTip === null || headTip === null) return { mergeable: 'CONFLICTING', baseTip, headTip, outcome: null };
  const base = mergeBase(repo.store, baseTip, headTip);
  const outcome = threeWayMerge(
    repo.store,
    commitTree(repo.store, base),
    commitTree(repo.store, baseTip),
    commitTree(repo.store, headTip),
  );
  return { mergeable: outcome.conflict ? 'CONFLICTING' : 'MERGEABLE', baseTip, headTip, outcome };
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line-diff counts between two texts (an LCS walk; whole-file counts for very large files). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length > 3000 || newLines.length > 3000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const m = oldLines.length;
  const n = newLines.length;
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j] ? dp[(i + 1) * (n + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}

/** The changed files between two commits (the pull-request files view). */
export function diffCommits(store: ObjectStore, baseCommit: string | null, headCommit: string | null): FileChange[] {
  const base = flattenTree(store, commitTree(store, baseCommit));
  const head = flattenTree(store, commitTree(store, headCommit));
  const paths = new Set([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b?.sha === h?.sha) continue;
    const oldText = b ? (store.get(b.sha)?.content.toString('utf8') ?? '') : '';
    const newText = h ? (store.get(h.sha)?.content.toString('utf8') ?? '') : '';
    const { additions, deletions } = lineDiff(oldText, newText);
    changes.push({
      path,
      status: b === undefined ? 'added' : h === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/** The files a pull request changes: its head against the merge base with its base. */
export function pullFiles(repo: Repo, pull: Pull): FileChange[] {
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  if (headTip === null) return [];
  const base = baseTip === null ? null : mergeBase(repo.store, baseTip, headTip);
  return diffCommits(repo.store, base, headTip);
}

/** Merge a pull request (squash or merge commit); the caller checks mergeability first. */
export function mergePull(forge: Forge, repo: Repo, pull: Pull, method: 'squash' | 'merge' | 'rebase'): { sha: string } {
  const { baseTip, headTip, outcome } = pullMergeability(repo, pull);
  if (baseTip === null || headTip === null || outcome === null) throw new ForgeError(405, 'Pull Request is not mergeable');
  if (outcome.conflict) throw new ForgeError(405, 'Pull Request is not mergeable: merge conflict');
  let sha: string;
  if (method === 'merge') {
    sha = makeCommit(forge, repo.store, {
      tree: outcome.tree,
      parents: [baseTip, headTip],
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
    });
  } else {
    // Squash (and rebase, approximated as squash here): one commit on the base.
    sha = makeCommit(forge, repo.store, {
      tree: outcome.tree,
      parents: [baseTip],
      message: `${pull.title} (#${pull.number})\n\n${pull.body}`,
    });
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = new Date(forge.nextTimestamp() * 1000).toISOString();
  return { sha };
}

export type { GitObjectType };
