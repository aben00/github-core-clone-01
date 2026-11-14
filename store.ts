// Forge state, kept entirely in memory: one process, no disk at all.
// Repositories, git objects and refs, issues, pull requests, labels and
// comments all live here. Everything is deterministic on purpose: the
// forge never reads the wall clock and never calls Math.random. All
// timestamps are one fixed epoch; ordering comes from sequence numbers.

import { createHash } from 'node:crypto';
import { scenarioUsers, FIXED_EPOCH_SEC, FIXED_ISO, type ScenarioUser } from './scenario.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function gitObjectId(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([head, data]));
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

// Decode a raw tree object into its entries, in stored order.
export function parseTree(data: Buffer): TreeEntry[] {
  const nodes: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const blank = data.indexOf(0x20, pos);
    const zero = data.indexOf(0x00, blank);
    const mode = data.subarray(pos, blank).toString('ascii');
    const name = data.subarray(blank + 1, zero).toString('utf8');
    const oid = data.subarray(zero + 1, zero + 21).toString('hex');
    nodes.push({ mode, name, oid });
    pos = zero + 21;
  }
  return nodes;
}

// Git sorts tree entries by name, except a directory compares as name + '/'.
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const ordered = [...entries].sort((x, y) => {
    const kx = treeSortKey(x);
    const ky = treeSortKey(y);
    if (kx < ky) return -1;
    if (kx > ky) return 1;
    return 0;
  });
  const chunks: Buffer[] = [];
  for (const entry of ordered) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const raw = data.toString('utf8');
  const gap = raw.indexOf('\n\n');
  const header = gap === -1 ? raw : raw.slice(0, gap);
  const message = gap === -1 ? '' : raw.slice(gap + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], message: string, user: ScenarioUser): Buffer {
  const who = `${user.name} <${user.email}> ${FIXED_EPOCH_SEC} +0000`;
  const rows = [
    `tree ${tree}`,
    ...parents.map((p) => `parent ${p}`),
    `author ${who}`,
    `committer ${who}`,
    '',
    message,
  ];
  return Buffer.from(rows.join('\n'), 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const raw = data.toString('utf8');
  const gap = raw.indexOf('\n\n');
  const header = gap === -1 ? raw : raw.slice(0, gap);
  const message = gap === -1 ? '' : raw.slice(gap + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
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
    const people = scenarioUsers();
    this.viewer = people.viewer;
    this.teammate = people.teammate;
    this.stranger = people.stranger;
  }

  // Monotonic counter used for X-GitHub-Request-Id; deterministic.
  nextCounter(): number {
    this.counter += 1;
    return this.counter;
  }

  // ---- git objects ---------------------------------------------------
  storeObject(type: GitObject['type'], data: Buffer): string {
    const oid = gitObjectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  object(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  commitOf(oid: string): ParsedCommit | null {
    const found = this.objects.get(oid);
    if (!found || found.type !== 'commit') return null;
    return parseCommit(found.data);
  }

  // Every commit reachable from `tip` by following parents, newest first.
  commitChain(tip: string): string[] {
    const visited = new Set<string>();
    const chain: string[] = [];
    const pending: string[] = [tip];
    while (pending.length > 0) {
      const oid = pending.pop() as string;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const parsed = this.commitOf(oid);
      if (!parsed) continue;
      chain.push(oid);
      for (let k = parsed.parents.length - 1; k >= 0; k -= 1) pending.push(parsed.parents[k]);
    }
    return chain;
  }

  isAncestor(maybeAncestor: string, oid: string): boolean {
    if (maybeAncestor === oid) return true;
    return this.commitChain(oid).includes(maybeAncestor);
  }

  // Objects a client that already holds `tips` already has: the tips
  // themselves plus each tip's tree closure (trees and blobs). The walk
  // stops at `stopAt` commits — a shallow boundary is held with its tree,
  // but its parents are not walked. Returns visited commits and objects.
  reachableObjects(tips: string[], stopAt: Set<string>): { commits: Set<string>; objects: Set<string> } {
    const commits = new Set<string>();
    const objects = new Set<string>();
    const absorbTree = (treeOid: string): void => {
      const found = this.objects.get(treeOid);
      if (!found || found.type !== 'tree' || objects.has(treeOid)) return;
      objects.add(treeOid);
      for (const entry of parseTree(found.data)) {
        if (entry.mode === '40000') absorbTree(entry.oid);
        else if (entry.mode !== '160000') objects.add(entry.oid);
      }
    };
    const pending = [...tips];
    while (pending.length > 0) {
      const oid = pending.pop() as string;
      if (commits.has(oid)) continue;
      const parsed = this.commitOf(oid);
      if (!parsed) continue;
      commits.add(oid);
      objects.add(oid);
      absorbTree(parsed.tree);
      if (stopAt.has(oid)) continue;
      for (const parent of parsed.parents) pending.push(parent);
    }
    return { commits, objects };
  }

  // Nearest common ancestor of a and b, found by BFS from a. Null if unrelated.
  mergeBase(a: string, b: string): string | null {
    const bSide = new Set(this.commitChain(b));
    const queue: string[] = [a];
    const seen = new Set<string>([a]);
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (bSide.has(oid)) return oid;
      const parsed = this.commitOf(oid);
      if (!parsed) continue;
      for (const parent of parsed.parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return null;
  }

  // Flatten a tree into path -> {oid, mode}. Gitlinks are skipped.
  treeMap(treeOid: string): Map<string, { oid: string; mode: string }> {
    const flat = new Map<string, { oid: string; mode: string }>();
    const descend = (oid: string, prefix: string): void => {
      const found = this.objects.get(oid);
      if (!found || found.type !== 'tree') return;
      for (const entry of parseTree(found.data)) {
        if (entry.mode === '160000') continue;
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') descend(entry.oid, path);
        else flat.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    descend(treeOid, '');
    return flat;
  }

  // Put (or, with blobOid null, remove) a path in a tree; returns the new tree oid.
  setPathInTree(rootTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((part) => part !== '');
    const rebuild = (treeOid: string | null, depth: number): string => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid) {
        const found = this.objects.get(treeOid);
        if (found && found.type === 'tree') {
          for (const entry of parseTree(found.data)) entries.set(entry.name, entry);
        }
      }
      const name = segments[depth];
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const childTree = child && child.mode === '40000' ? child.oid : null;
        const next = rebuild(childTree, depth + 1);
        const nextObj = this.objects.get(next);
        const emptied = nextObj && nextObj.type === 'tree' && parseTree(nextObj.data).length === 0 && blobOid === null;
        if (emptied) entries.delete(name);
        else entries.set(name, { mode: '40000', name, oid: next });
      }
      return this.storeObject('tree', buildTree([...entries.values()]));
    };
    return rebuild(rootTreeOid, 0);
  }

  blobAt(treeOid: string, path: string): { oid: string; data: Buffer } | null {
    const flat = this.treeMap(treeOid);
    const entry = flat.get(path);
    if (!entry) return null;
    const found = this.objects.get(entry.oid);
    if (!found || found.type !== 'blob') return null;
    return { oid: entry.oid, data: found.data };
  }

  // ---- repositories --------------------------------------------------
  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const badName = !/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100 || name === '.' || name === '..' || name.endsWith('.git');
    if (badName) throw new ApiError(422, 'Invalid repository name');
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
    const branched = repo.refs.get(`refs/heads/${refOrBranch}`);
    if (branched) return branched;
    if (this.objects.has(refOrBranch)) return refOrBranch;
    return undefined;
  }

  // Make a commit on `branch`, pointing it at the new commit.
  commitOnBranch(repo: Repo, branch: string, message: string, treeOid: string, parents: string[]): string {
    const data = buildCommit(treeOid, parents, message, this.viewer);
    const oid = this.storeObject('commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  // ---- contents ------------------------------------------------------
  putContent(repo: Repo, path: string, contentB64: string, message: string, branch: string | undefined, sha: string | undefined): { contentSha: string; commitSha: string; created: boolean } {
    const branchName = branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branchName}`);
    let oldTree: string | null = null;
    let existed = false;
    if (tip) {
      const parsed = this.commitOf(tip);
      if (!parsed) throw new ApiError(404, 'Branch has no commit');
      oldTree = parsed.tree;
      const current = this.blobAt(oldTree, path);
      existed = current !== null;
      if (sha !== undefined) {
        if (!current || current.oid.toLowerCase() !== sha.toLowerCase()) throw new ApiError(409, 'Stale sha: the file changed since the sha given');
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
    const parsed = this.commitOf(tip);
    if (!parsed) throw new ApiError(404, 'Not Found');
    const current = this.blobAt(parsed.tree, path);
    if (!current) throw new ApiError(404, 'Not Found');
    if (sha !== undefined && current.oid.toLowerCase() !== sha.toLowerCase()) throw new ApiError(409, 'Stale sha: the file changed since the sha given');
    const newTree = this.setPathInTree(parsed.tree, path, null);
    return this.commitOnBranch(repo, repo.defaultBranch, message || `Delete ${path}`, newTree, [tip]);
  }

  // ---- issues and pulls ----------------------------------------------
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
    const rows = text.split('\n');
    if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows.length;
  }

  lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const tally = (rows: string[]): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const row of rows) counts.set(row, (counts.get(row) ?? 0) + 1);
      return counts;
    };
    const oldRows = oldText === '' ? [] : oldText.split('\n');
    const newRows = newText === '' ? [] : newText.split('\n');
    if (oldRows.length > 0 && oldRows[oldRows.length - 1] === '') oldRows.pop();
    if (newRows.length > 0 && newRows[newRows.length - 1] === '') newRows.pop();
    const oldCounts = tally(oldRows);
    const newCounts = tally(newRows);
    let additions = 0;
    let deletions = 0;
    for (const [row, n] of newCounts) additions += Math.max(0, n - (oldCounts.get(row) ?? 0));
    for (const [row, n] of oldCounts) deletions += Math.max(0, n - (newCounts.get(row) ?? 0));
    return { additions, deletions };
  }

  diffTrees(baseTreeOid: string, headTreeOid: string): PullFile[] {
    const base = this.treeMap(baseTreeOid);
    const head = this.treeMap(headTreeOid);
    const files: PullFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const from = base.get(path);
      const to = head.get(path);
      if (from && !to) {
        const oldText = this.objects.get(from.oid)?.data.toString('utf8') ?? '';
        const deletions = this.countLines(oldText);
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!from && to) {
        const newText = this.objects.get(to.oid)?.data.toString('utf8') ?? '';
        const additions = this.countLines(newText);
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (from && to && from.oid !== to.oid) {
        const oldText = this.objects.get(from.oid)?.data.toString('utf8') ?? '';
        const newText = this.objects.get(to.oid)?.data.toString('utf8') ?? '';
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
    const headParsed = this.commitOf(headSha);
    const baseParsed = this.commitOf(baseSha);
    if (!headParsed || !baseParsed) throw new ApiError(422, 'Head or base branch has no commit');
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
      files: this.diffTrees(baseParsed.tree, headParsed.tree),
      seq: repo.seq,
    };
    repo.pulls.push(pull);
    return pull;
  }

  // True when head and base both changed the same path differently since the merge base.
  pullConflicts(repo: Repo, pull: Pull): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
    if (!baseTip || !headTip) return false;
    const base = this.mergeBase(headTip, baseTip);
    if (!base) return false;
    const baseParsed = this.commitOf(base);
    const headParsed = this.commitOf(headTip);
    const baseParsed2 = this.commitOf(baseTip);
    if (!baseParsed || !headParsed || !baseParsed2) return false;
    const baseFlat = this.treeMap(baseParsed.tree);
    const headFlat = this.treeMap(headParsed.tree);
    const baseFlat2 = this.treeMap(baseParsed2.tree);
    const changedSince = (from: Map<string, { oid: string }>, to: Map<string, { oid: string }>): Map<string, string | null> => {
      const out = new Map<string, string | null>();
      for (const [p, entry] of to) {
        const prior = from.get(p);
        if (!prior || prior.oid !== entry.oid) out.set(p, entry.oid);
      }
      for (const p of from.keys()) if (!to.has(p)) out.set(p, null);
      return out;
    };
    const headChanged = changedSince(baseFlat, headFlat);
    const baseChanged = changedSince(baseFlat, baseFlat2);
    for (const [p, headOid] of headChanged) {
      if (baseChanged.has(p) && baseChanged.get(p) !== headOid) return true;
    }
    return false;
  }

  mergePull(repo: Repo, pull: Pull): { sha: string; message: string } {
    if (pull.state !== 'open') throw new ApiError(405, 'Pull request is not open');
    if (this.pullConflicts(repo, pull)) throw new ApiError(405, 'Merge conflict: head and base both changed the same files');
    const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
    if (!headTip || !baseTip) throw new ApiError(404, 'Head or base branch does not exist');
    const headParsed = this.commitOf(headTip);
    if (!headParsed) throw new ApiError(404, 'Head branch has no commit');
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head.ref}\n\n${pull.title}`;
    const sha = this.commitOnBranch(repo, pull.base.ref, message, headParsed.tree, [baseTip]);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = sha;
    return { sha, message: 'Pull request successfully merged.' };
  }

  // ---- JSON shapes ---------------------------------------------------
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
