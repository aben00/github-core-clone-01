// The forge's in-memory store: repositories, git objects/refs, issues, pulls,
// labels, comments. One process, no disk. Deterministic: no wall clock, no
// Math.random anywhere — timestamps are a fixed epoch, ordering is by sequence.

import { createHash } from 'node:crypto';
import { scenarioUsers, FIXED_EPOCH_SEC, FIXED_ISO, type ScenarioUser } from './scenario.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function gitObjectId(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function b64u(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(i, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], message: string, user: ScenarioUser): Buffer {
  const ident = `${user.name} <${user.email}> ${FIXED_EPOCH_SEC} +0000`;
  const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${ident}`, `committer ${ident}`, '', message];
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export interface Issue {
  restId: number;
  gqlId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; gqlId: string; body: string }[];
  seq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  restId: number;
  gqlId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  files: PullFile[];
  seq: number;
}

export interface Repo {
  id: number;
  gqlId: string;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: Pull[];
  seq: number;
  createdSeq: number;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Store {
  viewer: ScenarioUser;
  teammate: ScenarioUser;
  stranger: ScenarioUser;
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  repoOrder: Repo[] = [];
  nextRepoId = 5000;
  nextIssueRestId = 1;
  nextCommentId = 1;
  private counter = 0;

  constructor() {
    const u = scenarioUsers();
    this.viewer = u.viewer;
    this.teammate = u.teammate;
    this.stranger = u.stranger;
  }

  /** Deterministic request counter (for X-GitHub-Request-Id). */
  nextCounter(): number {
    this.counter += 1;
    return this.counter;
  }

  // ---------------------------------------------------------- git objects
  storeObject(type: GitObject['type'], data: Buffer): string {
    const oid = gitObjectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  object(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  commitOf(oid: string): ParsedCommit | null {
    const o = this.objects.get(oid);
    if (!o || o.type !== 'commit') return null;
    return parseCommit(o.data);
  }

  /** All commit oids reachable from `tip` (following parents), newest first. */
  commitChain(tip: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const c = this.commitOf(oid);
      if (!c) continue;
      out.push(oid);
      for (let i = c.parents.length - 1; i >= 0; i -= 1) stack.push(c.parents[i]);
    }
    return out;
  }

  isAncestor(maybeAncestor: string, oid: string): boolean {
    if (maybeAncestor === oid) return true;
    const chain = this.commitChain(oid);
    return chain.includes(maybeAncestor);
  }

  /**
   * Every object a client holding `tips` already has: the tips themselves plus
   * each tip's tree closure (trees and blobs). The walk stops at `stopAt`
   * commits — a shallow boundary is held, together with its tree, but its
   * parents are not. Returns the visited commits and the full object set.
   */
  reachableObjects(tips: string[], stopAt: Set<string>): { commits: Set<string>; objects: Set<string> } {
    const commits = new Set<string>();
    const objects = new Set<string>();
    const addTree = (treeOid: string): void => {
      const o = this.objects.get(treeOid);
      if (!o || o.type !== 'tree' || objects.has(treeOid)) return;
      objects.add(treeOid);
      for (const e of parseTree(o.data)) {
        if (e.mode === '40000') addTree(e.oid);
        else if (e.mode !== '160000') objects.add(e.oid);
      }
    };
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (commits.has(oid)) continue;
      const commit = this.commitOf(oid);
      if (!commit) continue;
      commits.add(oid);
      objects.add(oid);
      addTree(commit.tree);
      if (stopAt.has(oid)) continue;
      for (const p of commit.parents) stack.push(p);
    }
    return { commits, objects };
  }

  /** Nearest common ancestor of a and b (BFS from a). Null when unrelated. */
  mergeBase(a: string, b: string): string | null {
    const bAncestors = new Set(this.commitChain(b));
    const queue: string[] = [a];
    const seen = new Set<string>([a]);
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (bAncestors.has(oid)) return oid;
      const c = this.commitOf(oid);
      if (!c) continue;
      for (const p of c.parents) {
        if (!seen.has(p)) {
          seen.add(p);
          queue.push(p);
        }
      }
    }
    return null;
  }

  /** Flatten a tree to path -> {oid, mode}. Gitlinks skipped. */
  treeMap(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const o = this.objects.get(oid);
      if (!o || o.type !== 'tree') return;
      for (const e of parseTree(o.data)) {
        if (e.mode === '160000') continue;
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { oid: e.oid, mode: e.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Set (or delete with blobOid null) a path in a tree; returns the new tree oid. */
  setPathInTree(rootTreeOid: string | null, path: string, blobOid: string | null): string {
    const parts = path.split('/').filter((p) => p !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid) {
        const o = this.objects.get(treeOid);
        if (o && o.type === 'tree') {
          for (const e of parseTree(o.data)) entries.set(e.name, e);
        }
      }
      const name = parts[depth];
      if (depth === parts.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const childTree = child && child.mode === '40000' ? child.oid : null;
        const next = build(childTree, depth + 1);
        const childObj = this.objects.get(next);
        if (childObj && childObj.type === 'tree' && parseTree(childObj.data).length === 0 && blobOid === null) {
          entries.delete(name);
        } else {
          entries.set(name, { mode: '40000', name, oid: next });
        }
      }
      return this.storeObject('tree', buildTree([...entries.values()]));
    };
    return build(rootTreeOid, 0);
  }

  blobAt(treeOid: string, path: string): { oid: string; data: Buffer } | null {
    const m = this.treeMap(treeOid);
    const e = m.get(path);
    if (!e) return null;
    const o = this.objects.get(e.oid);
    if (!o || o.type !== 'blob') return null;
    return { oid: e.oid, data: o.data };
  }

  // ---------------------------------------------------------- repos
  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100 || name === '.' || name === '..' || name.endsWith('.git')) {
      throw new ApiError(422, 'Invalid repository name');
    }
    const key = this.repoKey(this.viewer.login, name);
    if (this.repos.has(key)) throw new ApiError(422, 'Repository already exists');
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    const repo: Repo = {
      id,
      gqlId: b64u(`Repository:${id}`),
      owner: this.viewer.login,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      seq: 0,
      createdSeq: this.repoOrder.length,
    };
    this.repos.set(key, repo);
    this.repoOrder.push(repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    this.repoOrder = this.repoOrder.filter((r) => r !== repo);
  }

  viewerRepos(): Repo[] {
    return this.repoOrder.filter((r) => r.owner === this.viewer.login);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  resolveRef(repo: Repo, refOrBranch: string): string | undefined {
    if (repo.refs.has(refOrBranch)) return repo.refs.get(refOrBranch);
    const asBranch = repo.refs.get(`refs/heads/${refOrBranch}`);
    if (asBranch) return asBranch;
    if (this.objects.has(refOrBranch)) return refOrBranch;
    return undefined;
  }

  /** Create a commit on `branch` (default branch when omitted). */
  commitOnBranch(repo: Repo, branch: string, message: string, treeOid: string, parents: string[]): string {
    const data = buildCommit(treeOid, parents, message, this.viewer);
    const oid = this.storeObject('commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  // ---------------------------------------------------------- contents
  putContent(repo: Repo, path: string, contentB64: string, message: string, branch: string | undefined, sha: string | undefined): { contentSha: string; commitSha: string; created: boolean } {
    const branchName = branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branchName}`);
    let oldTree: string | null = null;
    let existed = false;
    if (tip) {
      const c = this.commitOf(tip);
      if (!c) throw new ApiError(404, 'Branch has no commit');
      oldTree = c.tree;
      const cur = this.blobAt(oldTree, path);
      existed = cur !== null;
      if (sha !== undefined) {
        if (!cur || cur.oid.toLowerCase() !== sha.toLowerCase()) throw new ApiError(409, 'Stale sha: the file changed since the sha given');
      }
    } else if (sha !== undefined) {
      throw new ApiError(409, 'Stale sha: the file does not exist');
    }
    const content = Buffer.from(contentB64, 'base64');
    const blobOid = this.storeObject('blob', content);
    const newTree = this.setPathInTree(oldTree, path, blobOid);
    const parents = tip ? [tip] : [];
    const commitSha = this.commitOnBranch(repo, branchName, message || `Update ${path}`, newTree, parents);
    return { contentSha: blobOid, commitSha, created: !existed };
  }

  deleteContent(repo: Repo, path: string, message: string, sha: string | undefined): string {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (!tip) throw new ApiError(404, 'Not Found');
    const c = this.commitOf(tip);
    if (!c) throw new ApiError(404, 'Not Found');
    const cur = this.blobAt(c.tree, path);
    if (!cur) throw new ApiError(404, 'Not Found');
    if (sha !== undefined && cur.oid.toLowerCase() !== sha.toLowerCase()) throw new ApiError(409, 'Stale sha: the file changed since the sha given');
    const newTree = this.setPathInTree(c.tree, path, null);
    return this.commitOnBranch(repo, repo.defaultBranch, message || `Delete ${path}`, newTree, [tip]);
  }

  // ---------------------------------------------------------- issues / pulls
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    for (const label of labels) {
      if (!repo.labels.has(label)) throw new ApiError(422, `Label does not exist: ${label}`);
    }
    repo.seq += 1;
    const number = repo.seq;
    const restId = this.nextIssueRestId;
    this.nextIssueRestId += 1;
    const issue: Issue = {
      restId,
      gqlId: b64u(`Issue:${repo.id}:${number}`),
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: repo.seq,
    };
    repo.issues.push(issue);
    return issue;
  }

  addComment(issue: Issue, body: string): { id: number; gqlId: string; body: string } {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    const comment = { id, gqlId: b64u(`IssueComment:${id}`), body };
    issue.comments.push(comment);
    return comment;
  }

  countLines(text: string): number {
    if (text === '') return 0;
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.length;
  }

  lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const count = (arr: string[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const l of arr) m.set(l, (m.get(l) ?? 0) + 1);
      return m;
    };
    const oldLines = oldText === '' ? [] : oldText.split('\n');
    const newLines = newText === '' ? [] : newText.split('\n');
    if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
    if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
    const o = count(oldLines);
    const n = count(newLines);
    let additions = 0;
    let deletions = 0;
    for (const [line, c] of n) additions += Math.max(0, c - (o.get(line) ?? 0));
    for (const [line, c] of o) deletions += Math.max(0, c - (n.get(line) ?? 0));
    return { additions, deletions };
  }

  diffTrees(baseTreeOid: string, headTreeOid: string): PullFile[] {
    const base = this.treeMap(baseTreeOid);
    const head = this.treeMap(headTreeOid);
    const files: PullFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const oldText = this.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const deletions = this.countLines(oldText);
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!b && h) {
        const newText = this.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const additions = this.countLines(newText);
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b && h && b.oid !== h.oid) {
        const oldText = this.objects.get(b.oid)?.data.toString('utf8') ?? '';
        const newText = this.objects.get(h.oid)?.data.toString('utf8') ?? '';
        const { additions, deletions } = this.lineDiff(oldText, newText);
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  createPull(repo: Repo, headRef: string, baseRef: string, title: string, body: string): Pull {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) throw new ApiError(422, 'Head or base branch does not exist');
    const headCommit = this.commitOf(headSha);
    const baseCommit = this.commitOf(baseSha);
    if (!headCommit || !baseCommit) throw new ApiError(422, 'Head or base branch has no commit');
    repo.seq += 1;
    const number = repo.seq;
    const restId = this.nextIssueRestId;
    this.nextIssueRestId += 1;
    const pull: Pull = {
      restId,
      gqlId: b64u(`PullRequest:${repo.id}:${number}`),
      number,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: '',
      mergeCommitSha: null,
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
      files: this.diffTrees(baseCommit.tree, headCommit.tree),
      seq: repo.seq,
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** True when head and base both changed the same path differently since merge-base. */
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
    if (!baseTip || !headTip) return false;
    const mb = this.mergeBase(headTip, baseTip);
    if (!mb) return false;
    const mbCommit = this.commitOf(mb);
    const headCommit = this.commitOf(headTip);
    const baseCommit = this.commitOf(baseTip);
    if (!mbCommit || !headCommit || !baseCommit) return false;
    const mbMap = this.treeMap(mbCommit.tree);
    const headMap = this.treeMap(headCommit.tree);
    const baseMap = this.treeMap(baseCommit.tree);
    const changed = (from: Map<string, { oid: string }>, to: Map<string, { oid: string }>): Map<string, string | null> => {
      const out = new Map<string, string | null>();
      for (const [p, e] of to) {
        const f = from.get(p);
        if (!f || f.oid !== e.oid) out.set(p, e.oid);
      }
      for (const p of from.keys()) if (!to.has(p)) out.set(p, null);
      return out;
    };
    const hChanged = changed(mbMap, headMap);
    const bChanged = changed(mbMap, baseMap);
    for (const [p, hOid] of hChanged) {
      if (bChanged.has(p) && bChanged.get(p) !== hOid) return true;
    }
    return false;
  }

  mergePull(repo: Repo, pull: Pull): { sha: string; message: string } {
    if (pull.state !== 'open') throw new ApiError(405, 'Pull request is not open');
    if (this.pullConflicts(repo, pull)) throw new ApiError(405, 'Merge conflict: head and base both changed the same files');
    const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
    if (!headTip || !baseTip) throw new ApiError(404, 'Head or base branch does not exist');
    const headCommit = this.commitOf(headTip);
    if (!headCommit) throw new ApiError(404, 'Head branch has no commit');
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head.ref}\n\n${pull.title}`;
    const sha = this.commitOnBranch(repo, pull.base.ref, message, headCommit.tree, [baseTip]);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = sha;
    return { sha, message: 'Pull request successfully merged.' };
  }

  // ---------------------------------------------------------- JSON shapes
  userJson(user: ScenarioUser): Record<string, unknown> {
    return { login: user.login, id: user.id, node_id: b64u(`User:${user.id}`), avatar_url: '', type: 'User', site_admin: false, name: user.name, email: user.email };
  }

  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: repo.gqlId,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: this.userJson(this.viewer),
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
      pushed_at: FIXED_ISO,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
      git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
      ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
      fork: false,
      archived: false,
      disabled: false,
      visibility: repo.private ? 'private' : 'public',
      license: null,
      has_issues: true,
      has_projects: false,
      has_downloads: true,
      has_wiki: false,
      has_pages: false,
    };
  }

  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.restId,
      node_id: issue.gqlId,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      locked: false,
      labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
      user: this.userJson(this.viewer),
      assignees: [],
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
      closed_at: issue.state === 'closed' ? FIXED_ISO : null,
      comments: issue.comments.length,
    };
  }

  pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
    return {
      id: pull.restId,
      node_id: pull.gqlId,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      locked: false,
      head: { label: `${repo.owner}:${pull.head.ref}`, ref: pull.head.ref, sha: pull.head.sha, user: this.userJson(this.viewer), repo: this.repoJson(repo) },
      base: { label: `${repo.owner}:${pull.base.ref}`, ref: pull.base.ref, sha: pull.base.sha, user: this.userJson(this.viewer), repo: this.repoJson(repo) },
      user: this.userJson(this.viewer),
      merged: pull.merged,
      mergeable: !this.pullConflicts(repo, pull),
      merged_at: pull.merged ? pull.mergedAt : null,
      merge_commit_sha: pull.mergeCommitSha,
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
      closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    };
  }
}
