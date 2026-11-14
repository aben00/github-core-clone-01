// GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments, pull requests. Shares the Store with git/GraphQL/MCP.

import { Store, ApiError, parseCommit, parseTree, type Repo } from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export class RestHandler {
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

  ok(status: number, body: unknown, extra: Record<string, string> = {}): RestResult {
    return {
      status,
      body,
      headers: { 'x-github-request-id': `req-${this.store.nextCounter()}`, ...extra },
    };
  }

  err(status: number, message: string): RestResult {
    return this.ok(status, { message }, {});
  }

  paginate<T>(items: T[], query: URLSearchParams, basePath: string, host: string): { page: T[]; link: string | null } {
    const perPage = Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30);
    const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
    const start = (page - 1) * perPage;
    const slice = items.slice(start, start + perPage);
    let link: string | null = null;
    if (start + perPage < items.length) {
      const next = new URLSearchParams(query);
      next.set('page', String(page + 1));
      next.set('per_page', String(perPage));
      link = `<http://${host}${basePath}?${next.toString()}>; rel="next"`;
    }
    return { page: slice, link };
  }

  pageHeaders(link: string | null): Record<string, string> {
    return link ? { link } : {};
  }

  handle(method: string, path: string, rawQuery: string, headers: Record<string, string | undefined>, bodyText: string, host: string): RestResult {
    try {
      if (!this.auth(headers)) return this.err(401, 'Requires authentication');
      const query = new URLSearchParams(rawQuery);
      let body: Record<string, unknown> = {};
      if (bodyText !== '' && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
        try {
          const parsed: unknown = JSON.parse(bodyText);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
          else if (parsed === null) body = {};
          else return this.err(400, 'Malformed JSON body');
        } catch {
          return this.err(400, 'Malformed JSON body');
        }
      }
      const segments = path.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
      return this.route(method, segments, query, body, host);
    } catch (err) {
      if (err instanceof ApiError) return this.err(err.status, err.message);
      return this.err(500, err instanceof Error ? err.message : 'Internal error');
    }
  }

  repoOr404(owner: string, name: string): Repo {
    if (owner !== this.store.viewer.login) throw new ApiError(404, 'Not Found');
    const repo = this.store.getRepo(owner, name);
    if (!repo) throw new ApiError(404, 'Not Found');
    return repo;
  }

  route(method: string, seg: string[], query: URLSearchParams, body: Record<string, unknown>, host: string): RestResult {
    // Root and meta
    if (seg.length === 0) {
      if (method === 'GET') {
        return this.ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
      }
      return this.err(404, 'Not Found');
    }
    if (seg[0] === 'meta') {
      if (method === 'GET') return this.ok(200, { installed_version: '1.0.0' });
      return this.err(404, 'Not Found');
    }
    if (seg[0] === 'user') {
      if (seg.length === 1) {
        if (method === 'GET') return this.ok(200, this.store.userJson(this.store.viewer));
        return this.err(404, 'Not Found');
      }
      if (seg[1] === 'repos') {
        if (method === 'GET') {
          const repos = this.store.viewerRepos();
          const { page, link } = this.paginate(repos, query, '/api/v3/user/repos', host);
          return this.ok(200, page.map((r) => this.store.repoJson(r)), this.pageHeaders(link));
        }
        if (method === 'POST') {
          const name = body['name'];
          if (typeof name !== 'string' || name === '') return this.err(422, 'name is required');
          const repo = this.store.createRepo(name, body['private'] === true, typeof body['description'] === 'string' ? body['description'] : '');
          return this.ok(201, this.store.repoJson(repo));
        }
        return this.err(404, 'Not Found');
      }
      return this.err(404, 'Not Found');
    }
    if (seg[0] !== 'repos' || seg.length < 3) return this.err(404, 'Not Found');
    const owner = seg[1];
    const repoName = seg[2];
    const repo = this.repoOr404(owner, repoName);
    const rest = seg.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return this.ok(200, this.store.repoJson(repo));
      if (method === 'PATCH') {
        if (typeof body['description'] === 'string') repo.description = body['description'];
        return this.ok(200, this.store.repoJson(repo));
      }
      if (method === 'DELETE') {
        this.store.deleteRepo(repo);
        return this.ok(204, null);
      }
      return this.err(404, 'Not Found');
    }

    switch (rest[0]) {
      case 'branches': {
        if (method !== 'GET') return this.err(404, 'Not Found');
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        return this.ok(200, branches);
      }
      case 'commits': {
        if (method !== 'GET') return this.err(404, 'Not Found');
        const shaParam = query.get('sha');
        const tip = shaParam ? this.store.resolveRef(repo, shaParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return this.ok(200, []);
        const chain = this.store.commitChain(tip);
        const items = chain.map((oid) => {
          const c = parseCommit((this.store.object(oid) as { data: Buffer }).data);
          return {
            sha: oid,
            node_id: `C_${oid}`,
            commit: {
              message: c.message,
              author: { name: this.store.viewer.name, email: this.store.viewer.email, date: '2025-01-01T00:00:00.000Z' },
              committer: { name: this.store.viewer.name, email: this.store.viewer.email, date: '2025-01-01T00:00:00.000Z' },
              tree: { sha: c.tree },
              url: `/api/v3/repos/${owner}/${repoName}/git/commits/${oid}`,
            },
            author: this.store.userJson(this.store.viewer),
            committer: this.store.userJson(this.store.viewer),
            parents: c.parents.map((p) => ({ sha: p })),
          };
        });
        const { page, link } = this.paginate(items, query, `/api/v3/repos/${owner}/${repoName}/commits`, host);
        return this.ok(200, page, this.pageHeaders(link));
      }
      case 'git': {
        if (rest[1] === 'refs') return this.gitRefs(method, repo, rest.slice(2), body);
        return this.err(404, 'Not Found');
      }
      case 'contents': {
        const filePath = rest.slice(1).join('/');
        if (method === 'PUT') {
          const content = body['content'];
          if (typeof content !== 'string') return this.err(422, 'content is required');
          const branch = typeof body['branch'] === 'string' ? body['branch'] : undefined;
          const sha = typeof body['sha'] === 'string' ? body['sha'] : undefined;
          const message = typeof body['message'] === 'string' ? body['message'] : `Update ${filePath}`;
          const result = this.store.putContent(repo, filePath, content, message, branch, sha);
          const size = Buffer.from(content, 'base64').length;
          return this.ok(result.created ? 201 : 200, {
            content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: result.contentSha, size, url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`, type: 'file', encoding: 'base64' },
            commit: { sha: result.commitSha, message },
          });
        }
        if (method === 'GET') {
          const refParam = query.get('ref');
          const tip = refParam ? this.store.resolveRef(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (!tip) throw new ApiError(404, 'Not Found');
          const commit = this.store.commitOf(tip);
          if (!commit) throw new ApiError(404, 'Not Found');
          if (filePath === '') {
            return this.ok(200, this.directoryEntries(repo, commit.tree, ''));
          }
          const blob = this.store.blobAt(commit.tree, filePath);
          if (blob) {
            return this.ok(200, {
              type: 'file',
              encoding: 'base64',
              content: blob.data.toString('base64'),
              sha: blob.oid,
              size: blob.data.length,
              name: filePath.split('/').pop() ?? filePath,
              path: filePath,
              url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
            });
          }
          // Directory?
          const dirEntries = this.directoryEntries(repo, commit.tree, filePath);
          if (dirEntries !== null) return this.ok(200, dirEntries);
          throw new ApiError(404, 'Not Found');
        }
        if (method === 'DELETE') {
          const sha = typeof body['sha'] === 'string' ? body['sha'] : undefined;
          const message = typeof body['message'] === 'string' ? body['message'] : `Delete ${filePath}`;
          const commitSha = this.store.deleteContent(repo, filePath, message, sha);
          return this.ok(200, { commit: { sha: commitSha, message } });
        }
        return this.err(404, 'Not Found');
      }
      case 'labels': {
        if (method === 'POST') {
          const name = body['name'];
          if (typeof name !== 'string' || name === '') return this.err(422, 'name is required');
          const color = typeof body['color'] === 'string' ? body['color'] : 'ededed';
          repo.labels.set(name, { name, color });
          return this.ok(201, { name, color, description: '' });
        }
        if (method === 'GET') {
          return this.ok(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
        }
        return this.err(404, 'Not Found');
      }
      case 'issues': {
        if (rest.length === 1) {
          if (method === 'POST') {
            const title = body['title'];
            if (typeof title !== 'string' || title === '') return this.err(422, 'title is required');
            const labels = Array.isArray(body['labels']) ? (body['labels'] as unknown[]).filter((l): l is string => typeof l === 'string') : [];
            const issue = this.store.createIssue(repo, title, typeof body['body'] === 'string' ? body['body'] : '', labels);
            return this.ok(201, this.store.issueJson(repo, issue));
          }
          if (method === 'GET') {
            const state = query.get('state') ?? 'open';
            let issues = repo.issues;
            if (state === 'open') issues = issues.filter((i) => i.state === 'open');
            else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
            const sort = query.get('sort') ?? 'created';
            const direction = query.get('direction') ?? 'desc';
            if (sort === 'created') {
              issues = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
            }
            const { page, link } = this.paginate(issues, query, `/api/v3/repos/${owner}/${repoName}/issues`, host);
            return this.ok(200, page.map((i) => this.store.issueJson(repo, i)), this.pageHeaders(link));
          }
          return this.err(404, 'Not Found');
        }
        const num = parseInt(rest[1], 10);
        if (!Number.isSafeInteger(num)) return this.err(404, 'Not Found');
        const issue = repo.issues.find((i) => i.number === num);
        if (!issue) throw new ApiError(404, 'Not Found');
        if (rest.length === 2) {
          if (method === 'GET') return this.ok(200, this.store.issueJson(repo, issue));
          if (method === 'PATCH') {
            if (body['state'] === 'closed' || body['state'] === 'open') issue.state = body['state'];
            if (typeof body['title'] === 'string') issue.title = body['title'];
            if (typeof body['body'] === 'string') issue.body = body['body'];
            return this.ok(200, this.store.issueJson(repo, issue));
          }
          return this.err(404, 'Not Found');
        }
        if (rest[2] === 'comments') {
          if (method === 'POST') {
            const b = body['body'];
            if (typeof b !== 'string') return this.err(422, 'body is required');
            const comment = this.store.addComment(issue, b);
            return this.ok(201, { id: comment.id, node_id: comment.gqlId, body: comment.body, user: this.store.userJson(this.store.viewer), created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z' });
          }
          if (method === 'GET') {
            return this.ok(200, issue.comments.map((c) => ({ id: c.id, node_id: c.gqlId, body: c.body, user: this.store.userJson(this.store.viewer), created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z' })));
          }
          return this.err(404, 'Not Found');
        }
        return this.err(404, 'Not Found');
      }
      case 'pulls': {
        if (rest.length === 1) {
          if (method === 'POST') {
            const head = body['head'];
            const base = body['base'];
            if (typeof head !== 'string' || typeof base !== 'string') return this.err(422, 'head and base are required');
            const title = typeof body['title'] === 'string' ? body['title'] : '';
            if (title === '') return this.err(422, 'title is required');
            const pull = this.store.createPull(repo, head, base, title, typeof body['body'] === 'string' ? body['body'] : '');
            return this.ok(201, this.store.pullJson(repo, pull));
          }
          if (method === 'GET') {
            const state = query.get('state');
            let pulls = repo.pulls;
            if (state === 'all') {
              // keep all
            } else if (state === 'closed') {
              pulls = pulls.filter((p) => p.state === 'closed');
            } else {
              pulls = pulls.filter((p) => p.state === 'open');
            }
            const { page, link } = this.paginate(pulls, query, `/api/v3/repos/${owner}/${repoName}/pulls`, host);
            return this.ok(200, page.map((p) => this.store.pullJson(repo, p)), this.pageHeaders(link));
          }
          return this.err(404, 'Not Found');
        }
        const num = parseInt(rest[1], 10);
        if (!Number.isSafeInteger(num)) return this.err(404, 'Not Found');
        const pull = repo.pulls.find((p) => p.number === num);
        if (rest.length === 2) {
          if (method === 'GET') {
            if (!pull) throw new ApiError(404, 'Not Found');
            return this.ok(200, this.store.pullJson(repo, pull));
          }
          return this.err(404, 'Not Found');
        }
        if (rest[2] === 'files') {
          if (method !== 'GET') return this.err(404, 'Not Found');
          if (!pull) throw new ApiError(404, 'Not Found');
          return this.ok(200, pull.files.map((f) => ({
            sha: '0000000000000000000000000000000000000000',
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            blob_url: '',
            raw_url: '',
            contents_url: '',
            patch: '',
          })));
        }
        if (rest[2] === 'merge') {
          if (method !== 'PUT') return this.err(404, 'Not Found');
          if (!pull) throw new ApiError(404, 'Not Found');
          const result = this.store.mergePull(repo, pull);
          return this.ok(200, { merged: true, sha: result.sha, message: result.message });
        }
        return this.err(404, 'Not Found');
      }
      default:
        return this.err(404, 'Not Found');
    }
  }

  gitRefs(method: string, repo: Repo, rest: string[], body: Record<string, unknown>): RestResult {
    if (method === 'POST' && rest.length === 0) {
      const ref = body['ref'];
      const sha = body['sha'];
      if (typeof ref !== 'string' || typeof sha !== 'string') return this.err(422, 'ref and sha are required');
      if (!ref.startsWith('refs/')) return this.err(422, 'ref must start with refs/');
      if (repo.refs.has(ref)) return this.err(422, 'Reference already exists');
      if (!this.store.object(sha)) return this.err(422, 'sha does not exist');
      repo.refs.set(ref, sha);
      return this.ok(201, { ref, node_id: `REF_${ref}_${sha}`, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.slice(5)}`, object: { sha, type: 'commit' } });
    }
    if (method === 'GET') {
      const prefix = rest.length === 0 ? 'refs/' : `refs/${rest.join('/')}`;
      const matches = [...repo.refs.entries()].filter(([ref]) => ref === prefix || ref.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || (rest.length > 0 && ref === `refs/${rest.join('/')}`));
      // Exact single ref?
      const exact = repo.refs.get(`refs/${rest.join('/')}`);
      if (rest.length > 0 && exact !== undefined) {
        const ref = `refs/${rest.join('/')}`;
        return this.ok(200, { ref, node_id: `REF_${ref}_${exact}`, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${rest.join('/')}`, object: { sha: exact, type: 'commit' } });
      }
      const items = matches
        .map(([ref, sha]) => ({ ref, node_id: `REF_${ref}_${sha}`, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.slice(5)}`, object: { sha, type: 'commit' } }))
        .sort((a, b) => (a.ref < b.ref ? -1 : 1));
      if (rest.length > 0 && items.length === 0) throw new ApiError(404, 'Not Found');
      return this.ok(200, items);
    }
    return this.err(404, 'Not Found');
  }

  /** Entries of the tree at `dirPath` ('' = root). Null when the path is not a directory. */
  directoryEntries(repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] | null {
    let current = treeOid;
    if (dirPath !== '') {
      const parts = dirPath.split('/').filter((p) => p !== '');
      for (const part of parts) {
        const obj = this.store.object(current);
        if (!obj || obj.type !== 'tree') return null;
        const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
        if (!entry) return null;
        current = entry.oid;
      }
    }
    const obj = this.store.object(current);
    if (!obj || obj.type !== 'tree') return null;
    return parseTree(obj.data).map((e) => {
      const isDir = e.mode === '40000';
      const blob = !isDir ? this.store.object(e.oid) : undefined;
      return {
        type: isDir ? 'dir' : 'file',
        name: e.name,
        path: dirPath === '' ? e.name : `${dirPath}/${e.name}`,
        sha: e.oid,
        size: blob ? blob.data.length : 0,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${dirPath === '' ? e.name : `${dirPath}/${e.name}`}`,
      };
    });
  }
}
