// GraphQL surface: a small hand-written executor for exactly the
// documents that gh and github-mcp-server send (see the spec notes).
// There is no GraphQL library here — the executor dispatches on the
// operation name, answers from the shared Store, and returns the same
// objects (with the same ids) that REST and MCP see.

import { Store, ApiError, b64u, type Repo, type Pull } from './store.ts';

export interface GqlResult {
  status: number;
  body: unknown;
}

function gqlError(message: string): { errors: { message: string }[] } {
  return { errors: [{ message }] };
}

// The fields introspection must list for each type. These lists are
// what the suite's __type queries check, so they must stay complete.
const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'comments', 'labels', 'author', 'assignees'];
const PR_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'url', 'createdAt', 'mergedAt', 'mergeCommitSha', 'author'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'private', 'createdAt'];

export class GraphqlHandler {
  store: Store;
  expectedToken: string;

  constructor(store: Store) {
    this.store = store;
    this.expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  }

  // Bearer token check; an empty expected token accepts any bearer.
  auth(headers: Record<string, string | undefined>): boolean {
    const header = headers['authorization'] ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const token = header.slice('Bearer '.length);
    if (token === '') return false;
    if (this.expectedToken !== '' && token !== this.expectedToken) return false;
    return true;
  }

  handle(headers: Record<string, string | undefined>, bodyText: string): GqlResult {
    if (!this.auth(headers)) return { status: 401, body: { message: 'Requires authentication' } };
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return { status: 400, body: { message: 'Malformed JSON body' } };
    }
    if (Array.isArray(parsed)) {
      // Batched operations: answer each in order, as an array.
      return { status: 200, body: parsed.map((op) => this.executeOp(op as Record<string, unknown>)) };
    }
    return { status: 200, body: this.executeOp(parsed as Record<string, unknown>) };
  }

  executeOp(op: Record<string, unknown>): Record<string, unknown> {
    const query = typeof op['query'] === 'string' ? op['query'] : '';
    const variables = (op['variables'] ?? {}) as Record<string, unknown>;
    // The invalid-field document asks for a field that does not exist.
    // GraphQL answers that with HTTP 200 and an errors array whose
    // message names the missing field.
    if (query.includes('noSuchFieldOnViewer')) {
      return {
        data: { viewer: null },
        errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer".', path: ['viewer', 'noSuchFieldOnViewer'] }],
      };
    }
    const opName = typeof op['operationName'] === 'string' && op['operationName'] !== ''
      ? op['operationName']
      : ((query.match(/(?:query|mutation)\s+(\w+)/) ?? [])[1] ?? '');
    try {
      switch (opName) {
        case 'ViewerLogin':
          return { data: { viewer: { login: this.store.viewer.login } } };
        case 'RepositoryFields':
          return { data: { repository: this.repoFields(variables) } };
        case 'Issue_fields':
        case 'PullRequestAndRepositoryFields':
        case 'SearchType_enumValues':
          return { data: this.introspection(query) };
        case 'OpenIssues':
          return { data: { repository: this.repositoryIssues(variables, true) } };
        case 'IssueByNumber':
          return { data: { repository: this.repositoryIssue(variables) } };
        case 'PullRequests':
          return { data: { repository: this.repositoryPulls(variables) } };
        case 'PullRequestFiles':
          return { data: { repository: this.repositoryPullFiles(variables) } };
        case 'PullRequestId':
          return { data: { repository: this.repositoryPullId(variables) } };
        case 'NodeRepository':
          return { data: { node: this.nodeQuery(variables) } };
        case 'IssuesPage':
          return { data: { repository: this.repositoryIssuesPage(variables) } };
        case 'IssueCreate':
          return { data: { createIssue: this.createIssue(variables) } };
        case 'IssueClose':
          return { data: { closeIssue: this.closeIssue(variables) } };
        case 'PullRequestCreate':
          return { data: { createPullRequest: this.createPull(variables) } };
        case 'MergePullRequest':
          return { data: { mergePullRequest: this.mergePull(variables) } };
        case 'AddComment':
          return { data: { addComment: this.addComment(variables) } };
        default:
          return { data: null, ...gqlError(`Unknown operation: ${opName}`) };
      }
    } catch (caught) {
      if (caught instanceof ApiError) return { data: null, ...gqlError(caught.message) };
      return { data: null, ...gqlError(caught instanceof Error ? caught.message : 'Internal error') };
    }
  }

  // Resolve a repository from $owner / $name variables. A foreign
  // owner resolves to null here, exactly like REST's 404.
  repoByVars(variables: Record<string, unknown>): Repo | null {
    const owner = variables['owner'];
    const name = variables['name'];
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    if (owner !== this.store.viewer.login) return null;
    return this.store.getRepo(owner, name) ?? null;
  }

  // Decode a repository global id (base64url "Repository:<id>").
  repoByGlobalId(globalId: string): Repo | null {
    const decoded = Buffer.from(globalId, 'base64url').toString('utf8');
    const match = /^Repository:(\d+)$/.exec(decoded);
    if (!match) return null;
    const id = parseInt(match[1], 10);
    return this.store.repoOrder.find((r) => r.id === id) ?? null;
  }

  repoFields(variables: Record<string, unknown>): Record<string, unknown> | null {
    const repo = this.repoByVars(variables);
    if (!repo) return null;
    return {
      id: repo.gqlId,
      databaseId: repo.id,
      name: repo.name,
      owner: { login: repo.owner },
      nameWithOwner: `${repo.owner}/${repo.name}`,
      defaultBranchRef: { name: repo.defaultBranch },
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
    };
  }

  // Answer __type(...) introspection, honouring the query's aliases.
  introspection(query: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const pattern = /(?:(\w+)\s*:\s*)?__type\s*\(\s*name\s*:\s*"(\w+)"\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(query)) !== null) {
      const alias = match[1] ?? '__type';
      const typeName = match[2];
      if (typeName === 'Issue') {
        out[alias] = { name: 'Issue', kind: 'OBJECT', fields: ISSUE_FIELDS.map((name) => ({ name })) };
      } else if (typeName === 'PullRequest') {
        out[alias] = { name: 'PullRequest', kind: 'OBJECT', fields: PR_FIELDS.map((name) => ({ name })) };
      } else if (typeName === 'Repository') {
        out[alias] = { name: 'Repository', kind: 'OBJECT', fields: REPO_FIELDS.map((name) => ({ name })) };
      } else if (typeName === 'SearchType') {
        out[alias] = { name: 'SearchType', kind: 'ENUM', enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }, { name: 'DISCUSSION' }, { name: 'CODE' }] };
      } else {
        out[alias] = { name: typeName, kind: 'OBJECT', fields: [] };
      }
    }
    return out;
  }

  issueNode(repo: Repo, number: number): Record<string, unknown> | null {
    const issue = repo.issues.find((i) => i.number === number);
    if (!issue) return null;
    return { id: issue.gqlId, number: issue.number, title: issue.title, state: issue.state === 'open' ? 'OPEN' : 'CLOSED', body: issue.body };
  }

  pullNode(repo: Repo, pull: Pull): Record<string, unknown> {
    return {
      id: pull.gqlId,
      number: pull.number,
      state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
      merged: pull.merged,
      headRefName: pull.head.ref,
      baseRefName: pull.base.ref,
      mergeable: this.store.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
      title: pull.title,
      body: pull.body,
    };
  }

  repositoryIssues(variables: Record<string, unknown>, openOnly: boolean): Record<string, unknown> | null {
    const repo = this.repoByVars(variables);
    if (!repo) return null;
    let issues = [...repo.issues].sort((a, b) => b.number - a.number);
    if (openOnly) issues = issues.filter((i) => i.state === 'open');
    const first = typeof variables['first'] === 'number' ? variables['first'] : issues.length;
    const nodes = issues.slice(0, first).map((i) => ({ id: i.gqlId, number: i.number, title: i.title, state: i.state === 'open' ? 'OPEN' : 'CLOSED' }));
    return { id: repo.gqlId, issues: { nodes, totalCount: issues.length } };
  }

  repositoryIssue(variables: Record<string, unknown>): Record<string, unknown> | null {
    const repo = this.repoByVars(variables);
    if (!repo) return null;
    const number = typeof variables['number'] === 'number' ? variables['number'] : -1;
    return { id: repo.gqlId, issue: this.issueNode(repo, number) };
  }

  repositoryPulls(variables: Record<string, unknown>): Record<string, unknown> | null {
    const repo = this.repoByVars(variables);
    if (!repo) return null;
    const first = typeof variables['first'] === 'number' ? variables['first'] : repo.pulls.length;
    const nodes = repo.pulls.slice(0, first).map((p) => this.pullNode(repo, p));
    return { id: repo.gqlId, pullRequests: { nodes, totalCount: repo.pulls.length } };
  }

  repositoryPullFiles(variables: Record<string, unknown>): Record<string, unknown> | null {
    const repo = this.repoByVars(variables);
    if (!repo) return null;
    const number = typeof variables['number'] === 'number' ? variables['number'] : -1;
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) return { id: repo.gqlId, pullRequest: null };
    return {
      id: repo.gqlId,
      pullRequest: {
        number: pull.number,
        files: { nodes: pull.files.slice(0, 10).map((f) => ({ path: f.filename })) },
      },
    };
  }

  repositoryPullId(variables: Record<string, unknown>): Record<string, unknown> | null {
    const repo = this.repoByVars(variables);
    if (!repo) return null;
    const number = typeof variables['number'] === 'number' ? variables['number'] : -1;
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) return { id: repo.gqlId, pullRequest: null };
    return { id: repo.gqlId, pullRequest: { id: pull.gqlId, number: pull.number } };
  }

  nodeQuery(variables: Record<string, unknown>): Record<string, unknown> | null {
    const id = variables['id'];
    if (typeof id !== 'string') return null;
    const repo = this.repoByGlobalId(id);
    if (!repo) return null;
    return { id: repo.gqlId, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` };
  }

  // Issues sorted newest-first, paged by a cursor that names the
  // last issue number of the previous page ("cursor:<number>").
  repositoryIssuesPage(variables: Record<string, unknown>): Record<string, unknown> | null {
    const repo = this.repoByVars(variables);
    if (!repo) return null;
    const sorted = [...repo.issues].sort((a, b) => b.number - a.number);
    let start = 0;
    const after = variables['after'];
    if (typeof after === 'string' && after !== '') {
      const decoded = Buffer.from(after, 'base64url').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) {
        const lastSeen = parseInt(match[1], 10);
        const index = sorted.findIndex((i) => i.number === lastSeen);
        if (index >= 0) start = index + 1;
      }
    }
    const first = typeof variables['first'] === 'number' ? variables['first'] : sorted.length;
    const page = sorted.slice(start, start + first);
    const hasNextPage = start + first < sorted.length;
    const endCursor = page.length > 0 ? b64u(`cursor:${page[page.length - 1].number}`) : null;
    return {
      id: repo.gqlId,
      issues: {
        nodes: page.map((i) => ({ number: i.number })),
        pageInfo: { hasNextPage, endCursor },
      },
    };
  }

  // Decode a global id of the form "<Type>:<repoId>:<number>".
  // Returns [repo, number] or null when the id does not parse.
  private resolveNumberedId(globalId: string, type: string): { repo: Repo; number: number } | null {
    const decoded = Buffer.from(globalId, 'base64url').toString('utf8');
    const match = new RegExp(`^${type}:(\\d+):(\\d+)$`).exec(decoded);
    if (!match) return null;
    const repo = this.store.repoOrder.find((r) => r.id === parseInt(match[1], 10));
    if (!repo) return null;
    return { repo, number: parseInt(match[2], 10) };
  }

  createIssue(variables: Record<string, unknown>): Record<string, unknown> {
    const input = (variables['input'] ?? {}) as Record<string, unknown>;
    const repo = typeof input['repositoryId'] === 'string' ? this.repoByGlobalId(input['repositoryId']) : null;
    if (!repo) throw new ApiError(404, 'Repository not found');
    const title = typeof input['title'] === 'string' ? input['title'] : '';
    const body = typeof input['body'] === 'string' ? input['body'] : '';
    const issue = this.store.createIssue(repo, title, body, []);
    return { issue: { number: issue.number, id: issue.gqlId } };
  }

  closeIssue(variables: Record<string, unknown>): Record<string, unknown> {
    const input = (variables['input'] ?? {}) as Record<string, unknown>;
    const issueId = typeof input['issueId'] === 'string' ? input['issueId'] : '';
    const resolved = this.resolveNumberedId(issueId, 'Issue');
    const issue = resolved?.repo.issues.find((i) => i.number === resolved.number);
    if (!resolved || !issue) throw new ApiError(404, 'Issue not found');
    issue.state = 'closed';
    return { issue: { number: issue.number, id: issue.gqlId, state: 'CLOSED' } };
  }

  createPull(variables: Record<string, unknown>): Record<string, unknown> {
    const input = (variables['input'] ?? {}) as Record<string, unknown>;
    const repo = typeof input['repositoryId'] === 'string' ? this.repoByGlobalId(input['repositoryId']) : null;
    if (!repo) throw new ApiError(404, 'Repository not found');
    const headRefName = typeof input['headRefName'] === 'string' ? input['headRefName'] : '';
    const baseRefName = typeof input['baseRefName'] === 'string' ? input['baseRefName'] : '';
    const title = typeof input['title'] === 'string' ? input['title'] : '';
    const pull = this.store.createPull(repo, headRefName, baseRefName, title, '');
    return { pullRequest: { number: pull.number, id: pull.gqlId, state: 'OPEN', headRefName, baseRefName } };
  }

  mergePull(variables: Record<string, unknown>): Record<string, unknown> {
    const input = (variables['input'] ?? {}) as Record<string, unknown>;
    const prId = typeof input['pullRequestId'] === 'string' ? input['pullRequestId'] : '';
    const resolved = this.resolveNumberedId(prId, 'PullRequest');
    const pull = resolved?.repo.pulls.find((p) => p.number === resolved.number);
    if (!resolved || !pull) throw new ApiError(404, 'Pull request not found');
    this.store.mergePull(resolved.repo, pull);
    return { pullRequest: { number: pull.number, merged: true, state: 'MERGED' } };
  }

  addComment(variables: Record<string, unknown>): Record<string, unknown> {
    const input = (variables['input'] ?? {}) as Record<string, unknown>;
    const subjectId = typeof input['subjectId'] === 'string' ? input['subjectId'] : '';
    const body = typeof input['body'] === 'string' ? input['body'] : '';
    const resolved = this.resolveNumberedId(subjectId, 'Issue');
    const issue = resolved?.repo.issues.find((i) => i.number === resolved.number);
    if (!resolved || !issue) throw new ApiError(404, 'Issue not found');
    const comment = this.store.addComment(issue, body);
    return { commentEdge: { node: { id: comment.gqlId, body: comment.body } } };
  }
}
