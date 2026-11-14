// MCP over streamable HTTP (JSON-RPC 2.0): both the modern 2026-07-28 era
// (server/discover) and the legacy handshake era (initialize +
// notifications/initialized). Shares the Store with REST/GraphQL.

import { Store, ApiError } from './store.ts';

export interface McpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// The tools list is built once: two tools/list calls answer byte for byte.
const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

export class McpHandler {
  store: Store;
  expectedToken: string;

  constructor(store: Store) {
    this.store = store;
    this.expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  }

  auth(headers: Record<string, string | undefined>): boolean {
    const auth = headers['authorization'] ?? '';
    if (!auth.startsWith('Bearer ')) return false;
    const token = auth.slice('Bearer '.length);
    if (token === '') return false;
    if (this.expectedToken !== '' && token !== this.expectedToken) return false;
    return true;
  }

  rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
    const err: Record<string, unknown> = { code, message };
    if (data !== undefined) err['data'] = data;
    return { jsonrpc: '2.0', id: id ?? null, error: err };
  }

  rpcResult(id: unknown, result: unknown): Record<string, unknown> {
    return { jsonrpc: '2.0', id: id ?? null, result };
  }

  handle(method: string, headers: Record<string, string | undefined>, bodyText: string): McpResult {
    // Notifications have no id and get 202 with no body.
    if (!this.auth(headers)) {
      return { status: 401, body: { message: 'Requires authentication' } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return { status: 400, body: this.rpcError(424242, -32700, 'Parse error') };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 400, body: this.rpcError(null, -32700, 'Parse error') };
    }
    const req = parsed as Record<string, unknown>;
    const id = req['id'] ?? null;
    const rpcMethod = typeof req['method'] === 'string' ? req['method'] : '';
    if (rpcMethod === 'notifications/initialized' || rpcMethod.startsWith('notifications/')) {
      return { status: 202, body: null };
    }
    const params = (req['params'] ?? {}) as Record<string, unknown>;
    switch (rpcMethod) {
      case 'server/discover': {
        const result: Record<string, unknown> = {
          supportedVersions: ['2026-07-28'],
          protocolVersion: '2026-07-28',
          capabilities: { tools: {} },
          serverInfo: { name: 'makefun-forge', version: '1.0.0' },
        };
        result['_meta'] = { 'io.modelcontextprotocol/serverInfo': { name: 'makefun-forge', version: '1.0.0' } };
        return { status: 200, body: this.rpcResult(id, result), headers: { 'mcp-protocol-version': '2026-07-28' } };
      }
      case 'initialize': {
        const offered = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2025-11-25';
        const accepted = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(offered) ? offered : '2025-11-25';
        return {
          status: 200,
          body: this.rpcResult(id, {
            protocolVersion: accepted,
            capabilities: { tools: {} },
            serverInfo: { name: 'makefun-forge', version: '1.0.0' },
          }),
          headers: { 'mcp-session-id': 'mcp-session-1', 'mcp-protocol-version': accepted },
        };
      }
      case 'tools/list': {
        return { status: 200, body: this.rpcResult(id, JSON.parse(TOOLS_LIST_JSON) as Record<string, unknown>) };
      }
      case 'tools/call': {
        return { status: 200, body: this.callTool(id, params) };
      }
      default:
        return { status: 200, body: this.rpcError(id, -32601, `Method not found: ${rpcMethod}`) };
    }
  }

  /** Resolve owner/repo from arguments, accepting a full_name fallback. */
  repoFromArgs(args: Record<string, unknown>): { owner: string; repo: string } | null {
    let owner = typeof args['owner'] === 'string' ? args['owner'] : '';
    let repo = typeof args['repo'] === 'string' ? args['repo'] : '';
    if ((owner === '' || repo === '') && typeof args['full_name'] === 'string') {
      const parts = args['full_name'].split('/');
      if (parts.length === 2) {
        owner = parts[0];
        repo = parts[1];
      }
    }
    if (owner === '' || repo === '') return null;
    return { owner, repo };
  }

  callTool(id: unknown, params: Record<string, unknown>): Record<string, unknown> {
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;
    // Accept a server prefix (github__create_issue): match by suffix.
    const canonical = TOOLS.find((t) => {
      const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const c = t.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return n === c || n.endsWith(c);
    });
    if (!canonical) return this.rpcError(id, -32602, `Unknown tool: ${name}`);
    const toolResult = (obj: Record<string, unknown>): Record<string, unknown> => ({
      content: [{ type: 'text', text: JSON.stringify(obj) }],
      structuredContent: obj,
    });
    const toolError = (message: string): Record<string, unknown> => ({
      content: [{ type: 'text', text: message }],
      isError: true,
    });
    try {
      switch (canonical.name) {
        case 'create_repo': {
          const repoName = args['name'];
          if (typeof repoName !== 'string' || repoName === '') return this.rpcResult(id, toolError('Missing required argument: name'));
          const repo = this.store.createRepo(repoName, args['private'] === true, typeof args['description'] === 'string' ? args['description'] : '');
          return this.rpcResult(id, toolResult(this.store.repoJson(repo) as Record<string, unknown>));
        }
        case 'get_repo': {
          const target = this.repoFromArgs(args);
          if (!target) return this.rpcResult(id, toolError('Missing required arguments: owner, repo'));
          if (target.owner !== this.store.viewer.login) return this.rpcResult(id, toolError('Repository not found'));
          const repo = this.store.getRepo(target.owner, target.repo);
          if (!repo) return this.rpcResult(id, toolError('Repository not found'));
          return this.rpcResult(id, toolResult(this.store.repoJson(repo) as Record<string, unknown>));
        }
        case 'create_issue': {
          const target = this.repoFromArgs(args);
          const title = args['title'];
          if (!target || typeof title !== 'string' || title === '') {
            return this.rpcResult(id, toolError('Missing required argument: title'));
          }
          if (target.owner !== this.store.viewer.login) return this.rpcResult(id, toolError('Repository not found'));
          const repo = this.store.getRepo(target.owner, target.repo);
          if (!repo) return this.rpcResult(id, toolError('Repository not found'));
          const issue = this.store.createIssue(repo, title, typeof args['body'] === 'string' ? args['body'] : '', []);
          return this.rpcResult(id, toolResult(this.store.issueJson(repo, issue) as Record<string, unknown>));
        }
        case 'list_issues': {
          const target = this.repoFromArgs(args);
          if (!target) return this.rpcResult(id, toolError('Missing required arguments: owner, repo'));
          if (target.owner !== this.store.viewer.login) return this.rpcResult(id, toolError('Repository not found'));
          const repo = this.store.getRepo(target.owner, target.repo);
          if (!repo) return this.rpcResult(id, toolError('Repository not found'));
          const state = typeof args['state'] === 'string' ? args['state'] : 'open';
          let issues = repo.issues;
          if (state === 'open') issues = issues.filter((i) => i.state === 'open');
          else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
          const list = issues.map((i) => this.store.issueJson(repo, i));
          return this.rpcResult(id, toolResult({ issues: list }));
        }
        case 'create_pull_request': {
          const target = this.repoFromArgs(args);
          const title = args['title'];
          const head = typeof args['head'] === 'string' ? args['head'] : '';
          const base = typeof args['base'] === 'string' ? args['base'] : '';
          if (!target || typeof title !== 'string' || title === '' || head === '' || base === '') {
            return this.rpcResult(id, toolError('Missing required arguments: owner, repo, title, head, base'));
          }
          if (target.owner !== this.store.viewer.login) return this.rpcResult(id, toolError('Repository not found'));
          const repo = this.store.getRepo(target.owner, target.repo);
          if (!repo) return this.rpcResult(id, toolError('Repository not found'));
          const pull = this.store.createPull(repo, head, base, title, typeof args['body'] === 'string' ? args['body'] : '');
          return this.rpcResult(id, toolResult(this.store.pullJson(repo, pull) as Record<string, unknown>));
        }
        case 'merge_pull_request': {
          const target = this.repoFromArgs(args);
          const pullNumber = args['pull_number'];
          if (!target || typeof pullNumber !== 'number') {
            return this.rpcResult(id, toolError('Missing required arguments: owner, repo, pull_number'));
          }
          if (target.owner !== this.store.viewer.login) return this.rpcResult(id, toolError('Repository not found'));
          const repo = this.store.getRepo(target.owner, target.repo);
          if (!repo) return this.rpcResult(id, toolError('Repository not found'));
          const pull = repo.pulls.find((p) => p.number === pullNumber);
          if (!pull) return this.rpcResult(id, toolError('Pull request not found'));
          const result = this.store.mergePull(repo, pull);
          return this.rpcResult(id, toolResult({ number: pull.number, pull_number: pull.number, merged: true, sha: result.sha, state: 'closed' }));
        }
        default:
          return this.rpcError(id, -32602, `Unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof ApiError) return this.rpcResult(id, toolError(err.message));
      return this.rpcResult(id, toolError(err instanceof Error ? err.message : 'Internal error'));
    }
  }
}
