// The HTTP server: one shared Forge behind four surfaces — REST v3
// (/api/v3), GraphQL (/api/graphql), MCP (/mcp) and git smart HTTP
// (/{owner}/{repo}.git/...). Every response carries an
// X-GitHub-Request-Id; every JSON error is GitHub's {message} shape.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Forge, ForgeError } from './forge.ts';
import { routeRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './git.ts';

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `makefun-${requestSeq.toString(36)}-${Date.now().toString(36)}`;
}

function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId, ...headers });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, requestId: string, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': requestId });
  res.end(body);
}

function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S.*)$/.exec(header);
  return match !== null && match[1].trim().length > 0;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req, res) => {
    handle(forge, req, res).catch(() => {
      // Last-resort guard: a handler bug must answer, never hang.
      try {
        if (!res.headersSent) sendJson(res, nextRequestId(), 500, { message: 'Internal error' });
        else res.end();
      } catch {
        /* the socket is gone; nothing left to do */
      }
    });
  });
  return server;
}

async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segments = url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
  const origin = `http://${req.headers.host ?? 'localhost'}`;
  const body = await readBody(req);
  const authed = isAuthed(req);

  // ---- boot probe ----------------------------------------------------------
  if (segments.length === 1 && segments[0] === 'healthz' && method === 'GET') {
    return sendJson(res, requestId, 200, { ok: true });
  }

  // ---- GraphQL -----------------------------------------------------------
  const joined = segments.join('/');
  if ((joined === 'api/graphql' || joined === 'graphql') && method === 'POST') {
    if (!authed) return sendJson(res, requestId, 401, { message: 'Requires authentication' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return sendJson(res, requestId, 400, { message: 'Problems parsing JSON' });
    }
    const runOne = (op: Record<string, unknown>): unknown => {
      let variables: Record<string, unknown> = {};
      if (typeof op.variables === 'object' && op.variables !== null) variables = op.variables as Record<string, unknown>;
      else if (typeof op.variables === 'string') {
        try {
          variables = JSON.parse(op.variables) as Record<string, unknown>;
        } catch {
          variables = {};
        }
      }
      return executeGraphQL(forge, typeof op.query === 'string' ? op.query : '', variables, typeof op.operationName === 'string' ? op.operationName : undefined);
    };
    if (Array.isArray(parsed)) {
      return sendJson(res, requestId, 200, parsed.map((op) => runOne((typeof op === 'object' && op !== null ? op : {}) as Record<string, unknown>)));
    }
    const single = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
    return sendJson(res, requestId, 200, runOne(single));
  }

  // ---- MCP ---------------------------------------------------------------
  if (joined === 'mcp' && method === 'POST') {
    if (!authed) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }));
    }
    const result = handleMcp(forge, body.toString('utf8'));
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
    return res.end(result.body);
  }

  // ---- git smart HTTP ------------------------------------------------------
  if (segments.length >= 3 && segments[1].endsWith('.git')) {
    const owner = segments[0];
    const repoName = segments[1].slice(0, -'.git'.length);
    const tail = segments.slice(2).join('/');
    const repo = forge.getRepo(owner, repoName);
    if (tail === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        return sendBuffer(res, requestId, 400, 'text/plain; charset=utf-8', Buffer.from('missing or unknown service'));
      }
      if (repo === null) return sendBuffer(res, requestId, 404, 'text/plain; charset=utf-8', Buffer.from('repository not found'));
      const protocol = req.headers['git-protocol'];
      const v2 = typeof protocol === 'string' && protocol.includes('version=2');
      const result = infoRefs(repo, service, v2);
      return sendBuffer(res, requestId, result.status, result.contentType, result.body);
    }
    if (tail === 'git-upload-pack' && method === 'POST') {
      if (repo === null) return sendBuffer(res, requestId, 404, 'text/plain; charset=utf-8', Buffer.from('repository not found'));
      const result = uploadPack(repo, body);
      return sendBuffer(res, requestId, result.status, result.contentType, result.body);
    }
    if (tail === 'git-receive-pack' && method === 'POST') {
      if (repo === null) return sendBuffer(res, requestId, 404, 'text/plain; charset=utf-8', Buffer.from('repository not found'));
      const result = await receivePack(repo, body);
      return sendBuffer(res, requestId, result.status, result.contentType, result.body);
    }
  }

  // ---- REST v3 -------------------------------------------------------------
  if (!authed) return sendJson(res, requestId, 401, { message: 'Requires authentication' });
  let restSegments = segments;
  if (restSegments[0] === 'api' && restSegments[1] === 'v3') restSegments = restSegments.slice(2);
  let jsonBody: unknown;
  if (body.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    try {
      jsonBody = JSON.parse(body.toString('utf8'));
    } catch {
      return sendJson(res, requestId, 400, { message: 'Problems parsing JSON' });
    }
  }
  try {
    const result = routeRest(forge, method, restSegments, url.searchParams, jsonBody, origin);
    return sendJson(res, requestId, result.status, result.body, { 'x-oauth-scopes': 'repo, user', ...(result.headers ?? {}) });
  } catch (err) {
    if (err instanceof ForgeError) return sendJson(res, requestId, err.status, { message: err.message }, { 'x-oauth-scopes': 'repo, user' });
    throw err;
  }
}
