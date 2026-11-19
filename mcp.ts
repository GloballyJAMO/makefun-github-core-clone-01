// The MCP endpoint github-mcp-server speaks: JSON-RPC 2.0 over POST /mcp
// with plain JSON responses (no SSE), the server/discover handshake, the
// legacy initialize fallback, and exactly the six canonical tools with the
// argument names the real server uses. Tool results mirror the REST shapes
// in both `content` text and `structuredContent`.

import { ForgeError, mergePull } from './forge.ts';
import type { Forge } from './forge.ts';
import { repoJson } from './serializers.ts';

export interface McpResult {
  status: number;
  body: string;
}

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'Repository name.' },
      description: { type: 'string', description: 'Repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get details of a GitHub repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner (user or organization login).' },
      repo: { type: 'string', description: 'Repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a GitHub repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Issue title.' },
      body: { type: 'string', description: 'Issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a GitHub repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a GitHub repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Pull request title.' },
      head: { type: 'string', description: 'The head branch to merge from.' },
      base: { type: 'string', description: 'The base branch to merge into.' },
      body: { type: 'string', description: 'Pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a GitHub repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner.' },
      repo: { type: 'string', description: 'Repository name.' },
      pull_number: { type: 'number', description: 'Pull request number.' },
      merge_method: { type: 'string', description: 'Merge method: merge or squash.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsList(): unknown[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  }));
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function toolSuccess(value: unknown): unknown {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

export function handleMcp(forge: Forge, rawBody: string): McpResult {
  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    message = parsed as Record<string, unknown>;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;

  // Notifications (no id) are accepted silently.
  if (id === undefined) return { status: 202, body: '' };

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[1];
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[1];
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: toolsList() });
    case 'tools/call':
      return callTool(forge, id, params);
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function callTool(forge: Forge, id: unknown, params: Record<string, unknown>): McpResult {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
  const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null) {
      return rpcError(id, -32602, `Missing required argument: ${required}`);
    }
  }
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  try {
    switch (tool.name) {
      case 'create_repo': {
        const repo = forge.createRepo(str('name'), typeof args.description === 'string' ? args.description : '', args.private === true);
        return rpcResult(id, toolSuccess(repoJson(repo)));
      }
      case 'get_repo': {
        const repo = forge.getRepo(str('owner'), str('repo'));
        if (repo === null) throw new ForgeError(404, 'Not Found');
        return rpcResult(id, toolSuccess(repoJson(repo)));
      }
      case 'create_issue': {
        const repo = forge.getRepo(str('owner'), str('repo'));
        if (repo === null) throw new ForgeError(404, 'Not Found');
        const issue = forge.createIssue(repo, { title: str('title'), body: typeof args.body === 'string' ? args.body : '' });
        return rpcResult(id, toolSuccess({
          id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state,
          html_url: `https://forge.invalid/${repo.fullName}/issues/${issue.number}`,
        }));
      }
      case 'list_issues': {
        const repo = forge.getRepo(str('owner'), str('repo'));
        if (repo === null) throw new ForgeError(404, 'Not Found');
        const state = typeof args.state === 'string' ? args.state : 'open';
        const issues = [...repo.issues.values()]
          .filter((issue) => state === 'all' || issue.state === state)
          .sort((a, b) => a.seq - b.seq)
          .map((issue) => ({
            id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state,
            html_url: `https://forge.invalid/${repo.fullName}/issues/${issue.number}`,
          }));
        return rpcResult(id, toolSuccess(issues));
      }
      case 'create_pull_request': {
        const repo = forge.getRepo(str('owner'), str('repo'));
        if (repo === null) throw new ForgeError(404, 'Not Found');
        const pull = forge.createPull(repo, { head: str('head'), base: str('base'), title: str('title'), body: typeof args.body === 'string' ? args.body : '' });
        return rpcResult(id, toolSuccess({
          id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state,
          head: { ref: pull.headRef }, base: { ref: pull.baseRef },
          html_url: `https://forge.invalid/${repo.fullName}/pull/${pull.number}`,
        }));
      }
      case 'merge_pull_request': {
        const repo = forge.getRepo(str('owner'), str('repo'));
        if (repo === null) throw new ForgeError(404, 'Not Found');
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
        const pull = repo.pulls.get(number);
        if (pull === undefined) throw new ForgeError(404, 'Not Found');
        const method = typeof args.merge_method === 'string' && args.merge_method === 'squash' ? 'squash' : 'merge';
        const { sha } = mergePull(forge, repo, pull, method);
        return rpcResult(id, toolSuccess({ sha, merged: true, message: 'Pull Request successfully merged' }));
      }
    }
  } catch (err) {
    if (err instanceof ForgeError) {
      return rpcResult(id, { content: [{ type: 'text', text: err.message }], isError: true });
    }
    return rpcError(id, -32603, err instanceof Error ? err.message : 'internal error');
  }
  return rpcError(id, -32602, `Unknown tool: ${name}`);
}
