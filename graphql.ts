// A compact GraphQL parser and executor for the v4 surface gh and
// github-mcp-server actually use: viewer, repository reads, issue and
// pull-request connections with cursor pagination, the five mutations,
// Relay node(id:), operation batching, and the __type probes gh's feature
// detection sends. Unknown fields are validation errors in the GitHub
// shape: HTTP 200, an errors array, the field named.

import { ForgeError, VIEWER, mergePull, pullMergeability, pullFiles } from './forge.ts';
import type { Forge, Issue, Pull, Repo } from './forge.ts';
import { globalId, parseGlobalId } from './serializers.ts';

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  name: string;
  alias: string | null;
  args: { name: string; value: Value }[];
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

export class GraphQLSyntaxError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():$[]!=@|&'.includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GraphQLSyntaxError('unterminated block string');
        tokens.push(`"${source.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          out += source[j] + source[j + 1];
          j += 2;
        } else {
          out += source[j];
          j++;
        }
      }
      if (j >= source.length) throw new GraphQLSyntaxError('unterminated string');
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j++;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j++;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new GraphQLSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos++];
    if (token === undefined) throw new GraphQLSyntaxError('unexpected end of document');
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GraphQLSyntaxError(`expected ${token}, got ${got}`);
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, SelectionNode[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek() !== undefined && /^[A-Za-z_]/.test(this.peek()!)) name = this.next();
        if (this.peek() === '(') this.parseVariableDefinitions();
        // Directives on the operation are skipped.
        while (this.peek() === '@') this.skipDirective();
        operations.push({ type: head === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        this.next(); // the type condition
        while (this.peek() === '@') this.skipDirective();
        fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new GraphQLSyntaxError(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private skipDirective(): void {
    this.expect('@');
    this.next();
    if (this.peek() === '(') {
      this.next();
      let depth = 1;
      while (depth > 0) {
        const token = this.next();
        if (token === '(') depth++;
        else if (token === ')') depth--;
      }
    }
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(') depth++;
      else if (token === ')') depth--;
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          while (this.peek() === '@') this.skipDirective();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'fragmentSpread', name: this.next() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: FieldNode['args'] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    while (this.peek() === '@') this.skipDirective();
    const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { name, alias, args, selectionSet };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token.startsWith('"')) {
      try {
        return { kind: 'string', value: JSON.parse(token) as string };
      } catch {
        return { kind: 'string', value: token.slice(1, -1) };
      }
    }
    if (token === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek() !== '}') {
        const fieldName = this.next();
        this.expect(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.\d/.test(token) || /^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// schema (the field lists are what __type reports and validation enforces)
// ---------------------------------------------------------------------------

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', '__type', '__schema', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'reopenIssue'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'databaseId'],
  Organization: ['id', 'login', 'name'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'isArchived',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'createdAt', 'updatedAt', 'url', 'homepageUrl', 'stargazerCount', 'forkCount', 'primaryLanguage', 'licenseInfo',
  ],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'id', 'message', 'authoredDate'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'repository', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'url', 'assignees', 'milestone', 'locked', 'viewerDidAuthor',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'mergedAt', 'closedAt',
    'mergeCommit', 'additions', 'deletions', 'changedFiles', 'url', 'commits', 'comments', 'isDraft', 'locked',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  ReopenIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType'],
  __Directive: ['name', 'description', 'locations', 'args'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt', 'used', 'nodeCount'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION', 'ORGANIZATION', 'MARKETPLACE', 'TOPIC'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  StatusState: ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'],
};

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

type Node =
  | { __type: 'User' }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'IssueComment'; id: number; body: string }
  | { __type: 'Ref'; name: string }
  | { __type: 'Commit'; oid: string }
  | { __type: 'Label'; repo: Repo; name: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; startCursor: string | null }
  | { __type: 'IssueConnection'; nodes: Node[]; pageInfo: Node; totalCount: number; cursors: string[] }
  | { __type: 'PullRequestConnection'; nodes: Node[]; pageInfo: Node; totalCount: number; cursors: string[] }
  | { __type: 'PullRequestChangedFileConnection'; nodes: Node[]; pageInfo: Node; totalCount: number }
  | { __type: 'LabelConnection'; nodes: Node[] }
  | { __type: 'PullRequestChangedFile'; path: string; additions: number; deletions: number; changeType: string }
  | { __type: 'Edge'; node: Node | null; cursor: string }
  | { __type: 'Payload'; payload: Record<string, Node | null> }
  | { __type: '__Type'; name: string }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string };

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

function pageInfoFor(total: number, start: number, pageLength: number): Node {
  return {
    __type: 'PageInfo',
    hasNextPage: start + pageLength < total,
    endCursor: pageLength > 0 ? cursorOf(start + pageLength - 1) : null,
    startCursor: pageLength > 0 ? cursorOf(start) : null,
  };
}

function repoByGlobalId(forge: Forge, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const dbId = Number(parsed.key);
  for (const repo of forge.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function issueByGlobalId(forge: Forge, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const [repoId, number] = parsed.key.split(':');
  for (const repo of forge.repos.values()) {
    if (repo.id === Number(repoId)) {
      const issue = repo.issues.get(Number(number));
      return issue === undefined ? null : { repo, issue };
    }
  }
  return null;
}

function pullByGlobalId(forge: Forge, id: string): { repo: Repo; pull: Pull } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const [repoId, number] = parsed.key.split(':');
  for (const repo of forge.repos.values()) {
    if (repo.id === Number(repoId)) {
      const pull = repo.pulls.get(Number(number));
      return pull === undefined ? null : { repo, pull };
    }
  }
  return null;
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx.variables);
  return out;
}

export function executeGraphQL(forge: Forge, query: string, variables: Record<string, unknown>, operationName?: string): { data: unknown; errors?: { message: string }[] } {
  let document: { operations: Operation[]; fragments: Map<string, SelectionNode[]> };
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const operation = document.operations.find((op) => operationName === undefined || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in the document' }] };
  const ctx: Ctx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors = validateSelections(operation.selectionSet, rootType, ctx);
  if (validationErrors.length > 0) return { data: null, errors: validationErrors };
  const data = executeSelectionSet(operation.selectionSet, rootType, null, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

function validateSelections(selections: SelectionNode[], typeName: string, ctx: Ctx): { message: string }[] {
  const errors: { message: string }[] = [];
  const fields = OBJECT_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      errors.push(...validateSelections(selection.selectionSet, selection.typeCondition, ctx));
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) errors.push(...validateSelections(fragment, typeName, ctx));
      continue;
    }
    const field = selection.field;
    if (field.name === '__typename') continue;
    if (fields === undefined || !fields.includes(field.name)) {
      errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      continue;
    }
    if (field.selectionSet !== null) {
      const childType = childTypeOf(typeName, field.name);
      if (childType !== null) errors.push(...validateSelections(field.selectionSet, childType, ctx));
    }
  }
  return errors;
}

/** The object type a field's selection set applies to (only what validation needs). */
function childTypeOf(parentType: string, fieldName: string): string | null {
  const map: Record<string, string> = {
    'Query.viewer': 'User',
    'Query.repository': 'Repository',
    'Query.node': 'Repository',
    'Query.__type': '__Type',
    'Repository.owner': 'User',
    'Repository.defaultBranchRef': 'Ref',
    'Repository.issue': 'Issue',
    'Repository.issues': 'IssueConnection',
    'Repository.pullRequest': 'PullRequest',
    'Repository.pullRequests': 'PullRequestConnection',
    'Issue.author': 'User',
    'Issue.repository': 'Repository',
    'Issue.labels': 'LabelConnection',
    'PullRequest.author': 'User',
    'PullRequest.repository': 'Repository',
    'PullRequest.files': 'PullRequestChangedFileConnection',
    'PullRequest.mergeCommit': 'Commit',
    'IssueConnection.nodes': 'Issue',
    'IssueConnection.edges': 'IssueEdge',
    'IssueConnection.pageInfo': 'PageInfo',
    'IssueEdge.node': 'Issue',
    'PullRequestConnection.nodes': 'PullRequest',
    'PullRequestConnection.edges': 'PullRequestEdge',
    'PullRequestConnection.pageInfo': 'PageInfo',
    'PullRequestEdge.node': 'PullRequest',
    'PullRequestChangedFileConnection.nodes': 'PullRequestChangedFile',
    'PullRequestChangedFileConnection.pageInfo': 'PageInfo',
    'LabelConnection.nodes': 'Label',
    'CreateIssuePayload.issue': 'Issue',
    'CloseIssuePayload.issue': 'Issue',
    'ReopenIssuePayload.issue': 'Issue',
    'CreatePullRequestPayload.pullRequest': 'PullRequest',
    'MergePullRequestPayload.pullRequest': 'PullRequest',
    'AddCommentPayload.commentEdge': 'IssueCommentEdge',
    'AddCommentPayload.subject': 'Issue',
    'IssueCommentEdge.node': 'IssueComment',
    '__Type.fields': '__Field',
    '__Type.enumValues': '__EnumValue',
    '__Type.inputFields': '__InputValue',
  };
  if (parentType === 'Mutation') {
    if (fieldName === 'createIssue' || fieldName === 'closeIssue' || fieldName === 'reopenIssue') return `${capitalize(fieldName)}Payload`;
    if (fieldName === 'createPullRequest' || fieldName === 'mergePullRequest') return `${capitalize(fieldName)}Payload`;
    if (fieldName === 'addComment') return 'AddCommentPayload';
  }
  return map[`${parentType}.${fieldName}`] ?? null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function executeSelectionSet(selections: SelectionNode[], typeName: string, source: Node | null, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (source !== null && source.__type === selection.typeCondition) {
        Object.assign(out, executeSelectionSet(selection.selectionSet, selection.typeCondition, source, ctx));
      } else if (source === null && typeName === selection.typeCondition) {
        Object.assign(out, executeSelectionSet(selection.selectionSet, selection.typeCondition, source, ctx));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelectionSet(fragment, typeName, source, ctx));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = source?.__type ?? typeName;
      continue;
    }
    try {
      const value = resolveField(typeName, source, field, ctx);
      out[key] = completeValue(value, field, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, field, ctx));
  if (typeof value === 'object' && '__type' in (value as Node)) {
    const node = value as Node;
    if (field.selectionSet === null) return node;
    return executeSelectionSet(field.selectionSet, node.__type, node, ctx);
  }
  return value;
}

// ---------------------------------------------------------------------------
// field resolvers
// ---------------------------------------------------------------------------

const isoOf = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();
// Matches the fixed timestamp the REST serializers stamp on everything.
const FIXED_NOW = '2026-01-01T00:00:00Z';
void isoOf;

function connectionPage<T>(items: T[], args: Record<string, unknown>): { page: T[]; start: number } {
  const first = typeof args.first === 'number' ? args.first : 30;
  const afterIndex = indexOfCursor(args.after);
  const start = afterIndex >= 0 ? afterIndex + 1 : 0;
  return { page: items.slice(start, start + first), start };
}

function resolveField(typeName: string, source: Node | null, field: FieldNode, ctx: Ctx): unknown {
  const args = argsOf(field, ctx);
  const forge = ctx.forge;

  if (typeName === 'Query') {
    switch (field.name) {
      case 'viewer':
        return { __type: 'User' } satisfies Node;
      case 'repository': {
        if (typeof args.owner !== 'string' || typeof args.name !== 'string') return null;
        const repo = forge.getRepo(args.owner, args.name);
        return repo === null ? null : ({ __type: 'Repository', repo } satisfies Node);
      }
      case 'node': {
        if (typeof args.id !== 'string') return null;
        const parsed = parseGlobalId(args.id);
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const repo = repoByGlobalId(forge, args.id);
          return repo === null ? null : ({ __type: 'Repository', repo } satisfies Node);
        }
        if (parsed.kind === 'Issue') {
          const found = issueByGlobalId(forge, args.id);
          return found === null ? null : ({ __type: 'Issue', repo: found.repo, issue: found.issue } satisfies Node);
        }
        if (parsed.kind === 'PullRequest') {
          const found = pullByGlobalId(forge, args.id);
          return found === null ? null : ({ __type: 'PullRequest', repo: found.repo, pull: found.pull } satisfies Node);
        }
        return null;
      }
      case 'nodes':
        return null;
      case '__type': {
        const name = typeof args.name === 'string' ? args.name : '';
        if (OBJECT_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined) return { __type: '__Type', name } satisfies Node;
        return null;
      }
      case '__schema':
        return null;
      case 'rateLimit':
        return null;
    }
  }

  if (typeName === 'Mutation') {
    const input = (typeof args.input === 'object' && args.input !== null ? args.input : args) as Record<string, unknown>;
    switch (field.name) {
      case 'createIssue': {
        const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(forge, input.repositoryId) : null;
        if (repo === null) throw new Error('repository not found');
        const issue = forge.createIssue(repo, { title: typeof input.title === 'string' ? input.title : '', body: typeof input.body === 'string' ? input.body : '' });
        const payload: Node = { __type: 'Payload', payload: { issue: { __type: 'Issue', repo, issue }, clientMutationId: null } };
        return retag(payload, 'CreateIssuePayload');
      }
      case 'closeIssue':
      case 'reopenIssue': {
        const found = typeof input.issueId === 'string' ? issueByGlobalId(forge, input.issueId) : null;
        if (found === null) throw new Error('issue not found');
        found.issue.state = field.name === 'closeIssue' ? 'closed' : 'open';
        const type = field.name === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload';
        return retag({ __type: 'Payload', payload: { issue: { __type: 'Issue', repo: found.repo, issue: found.issue }, clientMutationId: null } }, type);
      }
      case 'createPullRequest': {
        const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(forge, input.repositoryId) : null;
        if (repo === null) throw new Error('repository not found');
        const pull = forge.createPull(repo, {
          head: typeof input.headRefName === 'string' ? input.headRefName : '',
          base: typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
        });
        return retag({ __type: 'Payload', payload: { pullRequest: { __type: 'PullRequest', repo, pull }, clientMutationId: null } }, 'CreatePullRequestPayload');
      }
      case 'mergePullRequest': {
        const found = typeof input.pullRequestId === 'string' ? pullByGlobalId(forge, input.pullRequestId) : null;
        if (found === null) throw new Error('pull request not found');
        const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
        mergePull(forge, found.repo, found.pull, method === 'squash' ? 'squash' : 'merge');
        return retag({ __type: 'Payload', payload: { pullRequest: { __type: 'PullRequest', repo: found.repo, pull: found.pull }, clientMutationId: null } }, 'MergePullRequestPayload');
      }
      case 'addComment': {
        const found = typeof input.subjectId === 'string' ? issueByGlobalId(forge, input.subjectId) : null;
        if (found === null) throw new Error('subject not found');
        const comment = forge.addComment(found.repo, found.issue, typeof input.body === 'string' ? input.body : '');
        const node: Node = { __type: 'IssueComment', id: comment.id, body: comment.body };
        const edge: Node = { __type: 'Edge', node, cursor: cursorOf(0) };
        return retag({ __type: 'Payload', payload: { commentEdge: edge, subject: { __type: 'Issue', repo: found.repo, issue: found.issue }, clientMutationId: null } }, 'AddCommentPayload');
      }
    }
  }

  if (source === null) return null;

  // Mutation payloads were retagged with their concrete type name; their
  // fields live in the stored payload map regardless of that name.
  if ('payload' in source) {
    const payload = (source as { payload: Record<string, Node | null> }).payload;
    if (field.name === 'clientMutationId') return null;
    return payload[field.name] ?? null;
  }

  switch (source.__type) {
    case 'User':
      switch (field.name) {
        case 'id': return globalId('User', String(VIEWER.id));
        case 'login': return VIEWER.login;
        case 'name': return VIEWER.name;
        case 'email': return VIEWER.email;
        case 'databaseId': return VIEWER.id;
        case 'avatarUrl': return `https://avatars.example.invalid/${VIEWER.login}`;
        case 'url': return `https://forge.invalid/${VIEWER.login}`;
      }
      return null;

    case 'Repository': {
      const repo = source.repo;
      switch (field.name) {
        case 'id': return globalId('Repository', String(repo.id));
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'owner': return { __type: 'User' } satisfies Node;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'isFork': return false;
        case 'isArchived': return false;
        case 'defaultBranchRef': {
          const target = repo.headTarget();
          return repo.refs.has(target) ? ({ __type: 'Ref', name: repo.defaultBranch } satisfies Node) : null;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'createdAt': return FIXED_NOW;
        case 'updatedAt': return FIXED_NOW;
        case 'url': return `https://forge.invalid/${repo.fullName}`;
        case 'homepageUrl': return null;
        case 'stargazerCount': return 0;
        case 'forkCount': return 0;
        case 'primaryLanguage': return null;
        case 'licenseInfo': return null;
        case 'issue': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const issue = repo.issues.get(number);
          return issue === undefined ? null : ({ __type: 'Issue', repo, issue } satisfies Node);
        }
        case 'pullRequest': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : ({ __type: 'PullRequest', repo, pull } satisfies Node);
        }
        case 'issues': {
          let issues = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
          if (Array.isArray(args.states)) {
            const wanted = new Set((args.states as string[]).map((s) => s.toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = (typeof args.orderBy === 'object' && args.orderBy !== null ? args.orderBy : {}) as Record<string, unknown>;
          if (orderBy.direction === 'DESC') issues.reverse();
          const { page, start } = connectionPage(issues, args);
          const nodes: Node[] = page.map((issue) => ({ __type: 'Issue', repo, issue }));
          const conn: Node = {
            __type: 'IssueConnection',
            nodes,
            pageInfo: pageInfoFor(issues.length, start, page.length),
            totalCount: issues.length,
            cursors: page.map((_, i) => cursorOf(start + i)),
          };
          return conn;
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq);
          if (Array.isArray(args.states)) {
            const wanted = new Set(args.states as string[]);
            pulls = pulls.filter((pull) => wanted.has(pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED'));
          }
          const { page, start } = connectionPage(pulls, args);
          const nodes: Node[] = page.map((pull) => ({ __type: 'PullRequest', repo, pull }));
          const conn: Node = {
            __type: 'PullRequestConnection',
            nodes,
            pageInfo: pageInfoFor(pulls.length, start, page.length),
            totalCount: pulls.length,
            cursors: page.map((_, i) => cursorOf(start + i)),
          };
          return conn;
        }
      }
      return null;
    }

    case 'Ref':
      switch (field.name) {
        case 'name': return source.name;
        case 'prefix': return 'refs/heads/';
        case 'target': return null;
      }
      return null;

    case 'Commit':
      switch (field.name) {
        case 'oid': return source.oid;
        case 'id': return globalId('Commit', source.oid);
        case 'message': return '';
        case 'authoredDate': return null;
      }
      return null;

    case 'Issue': {
      const { repo, issue } = source;
      switch (field.name) {
        case 'id': return globalId('Issue', `${repo.id}:${issue.number}`);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'author': return { __type: 'User' } satisfies Node;
        case 'repository': return { __type: 'Repository', repo } satisfies Node;
        case 'createdAt': return FIXED_NOW;
        case 'updatedAt': return FIXED_NOW;
        case 'closedAt': return issue.state === 'closed' ? FIXED_NOW : null;
        case 'url': return `https://forge.invalid/${repo.fullName}/issues/${issue.number}`;
        case 'locked': return false;
        case 'viewerDidAuthor': return true;
        case 'labels': {
          const nodes: Node[] = issue.labels.map((name) => ({ __type: 'Label', repo, name }));
          return { __type: 'LabelConnection', nodes } satisfies Node;
        }
        case 'comments': return null;
        case 'assignees': return null;
        case 'milestone': return null;
      }
      return null;
    }

    case 'PullRequest': {
      const { repo, pull } = source;
      switch (field.name) {
        case 'id': return globalId('PullRequest', `${repo.id}:${pull.number}`);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': return pullMergeability(repo, pull).mergeable;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': return { __type: 'Ref', name: pull.headRef } satisfies Node;
        case 'baseRef': return { __type: 'Ref', name: pull.baseRef } satisfies Node;
        case 'author': return { __type: 'User' } satisfies Node;
        case 'repository': return { __type: 'Repository', repo } satisfies Node;
        case 'createdAt': return FIXED_NOW;
        case 'updatedAt': return FIXED_NOW;
        case 'mergedAt': return pull.mergedAt;
        case 'closedAt': return pull.merged ? pull.mergedAt : pull.state === 'closed' ? FIXED_NOW : null;
        case 'mergeCommit': return pull.mergeCommitSha === null ? null : ({ __type: 'Commit', oid: pull.mergeCommitSha } satisfies Node);
        case 'url': return `https://forge.invalid/${repo.fullName}/pull/${pull.number}`;
        case 'isDraft': return false;
        case 'locked': return false;
        case 'files': {
          const files = pullFiles(repo, pull);
          const first = typeof args.first === 'number' ? args.first : 100;
          const page = files.slice(0, first);
          const changeTypeOf = (status: string): string => (status === 'added' ? 'ADDED' : status === 'removed' ? 'REMOVED' : 'MODIFIED');
          const nodes: Node[] = page.map((file) => ({ __type: 'PullRequestChangedFile', path: file.path, additions: file.additions, deletions: file.deletions, changeType: changeTypeOf(file.status) }));
          const conn: Node = { __type: 'PullRequestChangedFileConnection', nodes, pageInfo: pageInfoFor(files.length, 0, page.length), totalCount: files.length };
          return conn;
        }
        case 'additions': return pullFiles(repo, pull).reduce((sum, file) => sum + file.additions, 0);
        case 'deletions': return pullFiles(repo, pull).reduce((sum, file) => sum + file.deletions, 0);
        case 'changedFiles': return pullFiles(repo, pull).length;
        case 'commits': return null;
        case 'comments': return null;
      }
      return null;
    }

    case 'IssueComment':
      switch (field.name) {
        case 'id': return globalId('IssueComment', String(source.id));
        case 'databaseId': return source.id;
        case 'body': return source.body;
        case 'author': return { __type: 'User' } satisfies Node;
        case 'createdAt': return FIXED_NOW;
        case 'updatedAt': return FIXED_NOW;
        case 'url': return 'https://forge.invalid/comment';
      }
      return null;

    case 'Label':
      switch (field.name) {
        case 'id': return globalId('Label', source.name);
        case 'name': return source.name;
        case 'color': return 'ededed';
        case 'description': return null;
      }
      return null;

    case 'PageInfo':
      switch (field.name) {
        case 'hasNextPage': return source.hasNextPage;
        case 'hasPreviousPage': return false;
        case 'startCursor': return source.startCursor;
        case 'endCursor': return source.endCursor;
      }
      return null;

    case 'IssueConnection':
    case 'PullRequestConnection':
      switch (field.name) {
        case 'nodes': return source.nodes;
        case 'pageInfo': return source.pageInfo;
        case 'totalCount': return source.totalCount;
        case 'edges': return source.nodes.map((node, i) => ({ __type: 'Edge', node, cursor: source.cursors[i] ?? cursorOf(i) }) satisfies Node);
      }
      return null;

    case 'PullRequestChangedFileConnection':
      switch (field.name) {
        case 'nodes': return source.nodes;
        case 'pageInfo': return source.pageInfo;
        case 'totalCount': return source.totalCount;
        case 'edges': return source.nodes.map((node, i) => ({ __type: 'Edge', node, cursor: cursorOf(i) }) satisfies Node);
      }
      return null;

    case 'LabelConnection':
      switch (field.name) {
        case 'nodes': return source.nodes;
        case 'edges': return source.nodes.map((node, i) => ({ __type: 'Edge', node, cursor: cursorOf(i) }) satisfies Node);
        case 'pageInfo': return pageInfoFor(source.nodes.length, 0, source.nodes.length);
        case 'totalCount': return source.nodes.length;
      }
      return null;

    case 'PullRequestChangedFile':
      switch (field.name) {
        case 'path': return source.path;
        case 'additions': return source.additions;
        case 'deletions': return source.deletions;
        case 'changeType': return source.changeType;
      }
      return null;

    case 'Edge':
      switch (field.name) {
        case 'node': return source.node;
        case 'cursor': return source.cursor;
      }
      return null;

    case 'Payload':
      return source.payload[field.name] ?? null;

    case '__Type':
      switch (field.name) {
        case 'kind': return ENUM_VALUES[source.name] !== undefined ? 'ENUM' : 'OBJECT';
        case 'name': return source.name;
        case 'description': return null;
        case 'fields': {
          const fields = OBJECT_FIELDS[source.name];
          if (fields === undefined) return null;
          const includeDeprecated = args.includeDeprecated !== false;
          void includeDeprecated;
          return fields.map((name) => ({ __type: '__Field', name }) satisfies Node);
        }
        case 'enumValues': {
          const values = ENUM_VALUES[source.name];
          if (values === undefined) return null;
          return values.map((name) => ({ __type: '__EnumValue', name }) satisfies Node);
        }
        case 'possibleTypes': return null;
        case 'inputFields': return null;
        case 'ofType': return null;
        case 'specifiedByURL': return null;
      }
      return null;

    case '__Field':
      switch (field.name) {
        case 'name': return source.name;
        case 'description': return null;
        case 'args': return [];
        case 'type': return null;
        case 'isDeprecated': return false;
        case 'deprecationReason': return null;
      }
      return null;

    case '__EnumValue':
      switch (field.name) {
        case 'name': return source.name;
        case 'description': return null;
        case 'isDeprecated': return false;
        case 'deprecationReason': return null;
      }
      return null;
  }
  return null;
}

/**
 * Payload wrappers carry their concrete type name for __typename and
 * validation. The generic Payload node stores fields; retag clones it with
 * the payload type so executeSelectionSet can dispatch on it.
 */
function retag(node: Node, type: string): Node {
  if (node.__type !== 'Payload') return node;
  return { ...(node as unknown as Record<string, unknown>), __type: type } as unknown as Node;
}

export { ForgeError };
