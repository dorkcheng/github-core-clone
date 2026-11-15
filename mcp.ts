// MCP (Model Context Protocol), streamable HTTP on POST /mcp: the modern 2026-07-28
// `server/discover` era and the legacy `initialize` handshake, a static tools/list, and
// tools/call over the same Store the REST and GraphQL surfaces use. Plain JSON replies
// (no SSE), JSON-RPC ids echoed verbatim, no session id. A tool failure is an isError
// tool result, never an HTTP 500; an unknown method is -32601; a non-JSON body is -32700.

import type { HttpResponse } from './git.ts';
import { jsonResponse } from './git.ts';
import type { Store } from './store.ts';

const SERVER_NAME = 'github-core-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-06-18', '2024-11-05'];

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: readonly McpTool[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner of the repository. Defaults to the authenticated user.' },
      },
      required: ['name'],
    },
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state. Defaults to open.' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  }),
  Object.freeze({
    name: 'get_issue',
    description: 'Get an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  }),
  Object.freeze({
    name: 'list_repositories',
    description: 'List the authenticated user\u2019s repositories.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  }),
]);

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(id: unknown, result: unknown): HttpResponse {
  return jsonResponse(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): HttpResponse {
  return jsonResponse(200, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** Run one tool call; throws an Error whose message becomes the isError text. */
function callTool(store: Store, name: string, args: JsonObject): Record<string, unknown> {
  const stringArg = (key: string): string => {
    const value = args[key];
    if (typeof value !== 'string' || value === '') throw new Error(`missing required argument: ${key}`);
    return value;
  };
  const numberArg = (key: string): number => {
    const value = args[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`missing required argument: ${key}`);
    return value;
  };

  if (name === 'create_repo') {
    const repoName = stringArg('name');
    const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : store.viewer.login;
    if (store.getRepo(owner, repoName)) throw new Error(`Repository ${owner}/${repoName} already exists`);
    const repo = store.createRepo(owner, repoName, {
      description: typeof args.description === 'string' ? args.description : undefined,
      isPrivate: typeof args.private === 'boolean' ? args.private : undefined,
    });
    return toolResult(store.repoJson(repo));
  }
  if (name === 'get_repo') {
    const repo = store.getRepo(stringArg('owner'), stringArg('repo'));
    if (!repo) throw new Error('Not Found');
    return toolResult(store.repoJson(repo));
  }
  if (name === 'create_issue') {
    const repo = store.getRepo(stringArg('owner'), stringArg('repo'));
    if (!repo) throw new Error('Not Found');
    const issue = store.createIssue(repo, {
      title: stringArg('title'),
      body: typeof args.body === 'string' ? args.body : undefined,
    });
    return toolResult(store.issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const repo = store.getRepo(stringArg('owner'), stringArg('repo'));
    if (!repo) throw new Error('Not Found');
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    else if (state !== 'all') throw new Error(`unknown state ${state}`);
    issues.sort((a, b) => a.seq - b.seq);
    return toolResult({ issues: issues.map((issue) => store.issueJson(repo, issue)) });
  }
  if (name === 'create_pull_request') {
    const repo = store.getRepo(stringArg('owner'), stringArg('repo'));
    if (!repo) throw new Error('Not Found');
    const head = stringArg('head');
    const base = stringArg('base');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
    if (duplicate) throw new Error('A pull request already exists for this head and base');
    const pull = store.createPull(repo, {
      title: stringArg('title'),
      body: typeof args.body === 'string' ? args.body : undefined,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
    });
    return toolResult(store.pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const repo = store.getRepo(stringArg('owner'), stringArg('repo'));
    if (!repo) throw new Error('Not Found');
    const pull = repo.pulls.find((candidate) => candidate.number === numberArg('pull_number'));
    if (!pull) throw new Error('Not Found');
    if (pull.state === 'closed') throw new Error('Pull request is already closed');
    const result = store.mergePull(repo, pull, 'squash');
    if (!result.merged) {
      throw new Error(result.conflicts ? `Merge conflict in ${result.conflicts.join(', ')}` : 'Pull request cannot be merged');
    }
    return toolResult({ merged: true, sha: result.sha, message: result.message });
  }
  if (name === 'get_issue') {
    const repo = store.getRepo(stringArg('owner'), stringArg('repo'));
    if (!repo) throw new Error('Not Found');
    const issue = repo.issues.find((candidate) => candidate.number === numberArg('issue_number'));
    if (!issue) throw new Error('Not Found');
    return toolResult(store.issueJson(repo, issue));
  }
  if (name === 'list_repositories') {
    const repos = store.listUserRepos(store.viewer.login).sort((a, b) => a.id - b.id);
    return toolResult({ repositories: repos.map((repo) => store.repoJson(repo)) });
  }
  throw new Error(`unknown tool: ${name}`);
}

export function handleMcp(store: Store, body: Buffer): HttpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonResponse(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON' } });
  }
  if (!isJsonObject(parsed)) {
    return jsonResponse(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request must be a JSON object' } });
  }
  const id = 'id' in parsed ? parsed.id : null;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isJsonObject(parsed.params) ? parsed.params : {};

  // Notifications carry no id and expect a 202 with an empty body.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, headers: {}, body: '' };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0];
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isJsonObject(params.arguments) ? params.arguments : {};
    if (toolName === '') {
      return rpcError(id, -32602, 'Invalid params: tools/call requires a tool name');
    }
    if (!TOOLS.some((tool) => tool.name === toolName)) {
      return rpcError(id, -32601, `Method not found: ${toolName}`);
    }
    try {
      return rpcResult(id, callTool(store, toolName, args));
    } catch (error) {
      return rpcResult(id, toolError((error as Error).message));
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
