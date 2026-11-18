// Git smart-HTTP handlers: info/refs advertisements, upload-pack
// (protocol v2 and v0) and receive-pack (v0). These are wired into
// app.ts and share the Store with the REST, GraphQL and MCP surfaces,
// so a ref created by a push is immediately visible everywhere else.

import { Store, ZERO_OID, ApiError, parseTag, type Repo } from './store.ts';
import {
  pktLine, PKT_FLUSH, PKT_DELIM, parsePktLines, parsePack, buildPack,
  planFetch, collectFetchObjects,
} from './git.ts';

// Capabilities advertised on the v0 upload-pack and receive-pack
// advertisements. The client refuses a fetch without side-band-64k,
// and refuses a shallow fetch unless `shallow` is listed.
const UPLOAD_CAPS_V0 = 'side-band-64k multi_ack_detailed thin-pack ofs-delta shallow agent=makefun-forge/1.0 symref=HEAD:refs/heads/main';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';
const AGENT = 'makefun-forge/1.0';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function textBuffer(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

// All refs of a repo, sorted by ref name.
function listRefs(repo: Repo): { ref: string; oid: string; tagTarget?: string }[] {
  const entries = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const out: { ref: string; oid: string; tagTarget?: string }[] = [];
  for (const [ref, oid] of entries) out.push({ ref, oid });
  return out;
}

// The tip of the repo's default branch, or the zero oid when unborn.
function defaultBranchTip(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

// Build a v0 advertisement body, with peeled lines for annotated tags.
// The caller adds the `# service=` preamble and flush before it.
function buildV0Advertisement(store: Store, repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const caps = service === 'upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${defaultBranchTip(repo)} HEAD\0${caps}\n`));
    for (const { ref, oid } of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const obj = store.object(oid);
      if (obj && obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        parts.push(pktLine(`${target} ${ref}^{}\n`));
      }
    }
  }
  // An advertisement ends with a flush packet. Without it, git waits
  // for more lines, the body ends, and it reports that the remote end
  // hung up unexpectedly.
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// The v2 advertisement: one capability per pkt-line, then a flush.
// It never mentions a repository, so one copy serves every request.
const V2_ADVERTISEMENT = (() => {
  const captions = [
    'version 2\n',
    'ls-refs=peel symrefs unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
  ];
  return Buffer.concat([...captions.map((line) => pktLine(line)), PKT_FLUSH]);
})();

export function handleInfoRefs(store: Store, repo: Repo | undefined, service: string, gitProtocol: string): GitResponse {
  if (!repo) return { status: 404, contentType: 'application/json; charset=utf-8', body: textBuffer('{"message":"Not Found"}\n') };
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: V2_ADVERTISEMENT };
    }
    const body = Buffer.concat([pktLine('# service=git-upload-pack\n'), PKT_FLUSH, buildV0Advertisement(store, repo, 'upload-pack')]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  if (service === 'git-receive-pack') {
    const body = Buffer.concat([pktLine('# service=git-receive-pack\n'), PKT_FLUSH, buildV0Advertisement(store, repo, 'receive-pack')]);
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body };
  }
  return { status: 404, contentType: 'application/json; charset=utf-8', body: textBuffer('{"message":"Not Found"}\n') };
}

// ---------------------------------------------------------------- upload-pack v2
interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  filter: string | null;
}

// Parse the want/have/shallow/deepen/filter lines of a fetch request.
// A v0 first want line carries features after the oid: only the first
// token is the oid. Git sends the same oid twice on a clone (once for
// HEAD, once for its branch), so wants are de-duplicated here.
function parseFetchArguments(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [], filter: null };
  for (const line of lines) {
    const trimmed = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (trimmed.startsWith('want ')) {
      const oid = trimmed.slice(5).trim().split(' ')[0];
      if (!args.wants.includes(oid)) args.wants.push(oid);
    } else if (trimmed.startsWith('have ')) args.haves.push(trimmed.slice(5).trim().split(' ')[0]);
    else if (trimmed.startsWith('shallow ')) args.shallow.push(trimmed.slice(8).trim());
    else if (trimmed.startsWith('deepen ')) args.deepen = parseInt(trimmed.slice(7).trim(), 10);
    else if (trimmed.startsWith('deepen-since ')) args.deepenSince = parseInt(trimmed.slice(13).trim(), 10);
    else if (trimmed.startsWith('deepen-not ')) args.deepenNot.push(trimmed.slice(11).trim());
    else if (trimmed.startsWith('filter ')) args.filter = trimmed.slice(7).trim();
  }
  return args;
}

// The argument lines after the first delim (0001) packet of a v2 body.
function argsAfterDelim(body: Buffer): string[] {
  let cursor = 0;
  while (cursor + 4 <= body.length) {
    const length = parseInt(body.subarray(cursor, cursor + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) return [];
    if (length === 0) return [];
    if (length === 1) return parsePktLines(body, cursor + 4).lines;
    if (length < 4 || cursor + length > body.length) return [];
    cursor += length;
  }
  return [];
}

// The one-byte band-1 prefix every sideband packet carries, allocated
// once instead of once per packet.
const SIDEBAND_BAND1 = Buffer.from([1]);

// ---------------------------------------------------------------- fetch cache
//
// Complete upload-pack fetch responses, keyed by the repository and the
// exact fetch arguments. Git objects are immutable, and a fetch's
// answer depends only on which objects the client holds and which it
// wants, so a cached response stays correct for the life of the
// process: a push can only produce a new key (a new wanted tip), never
// change an old answer. A depth-1 clone round is fifty identical
// fetches of the same tip, so the second and later clones skip the
// plan, the object collection and the pack build entirely. Bounded by
// bytes, oldest first out; a single response larger than the budget is
// simply not cached.
const FETCH_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const fetchCache = new Map<string, Buffer>();
let fetchCacheBytes = 0;

function fetchCacheKey(repo: Repo, version: 'v2' | 'v0', args: FetchArgs): string {
  return `${repo.id}|${version}|${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.deepen}|${args.deepenSince}|${args.deepenNot.join(',')}|${args.filter ?? ''}`;
}

function fetchCachePut(key: string, body: Buffer): void {
  if (body.length > FETCH_CACHE_MAX_BYTES) return;
  const prev = fetchCache.get(key);
  if (prev !== undefined) fetchCacheBytes -= prev.length;
  while (fetchCacheBytes + body.length > FETCH_CACHE_MAX_BYTES && fetchCache.size > 0) {
    const oldest = fetchCache.keys().next().value as string;
    const removed = fetchCache.get(oldest);
    if (removed !== undefined) fetchCacheBytes -= removed.length;
    fetchCache.delete(oldest);
  }
  fetchCache.set(key, body);
  fetchCacheBytes += body.length;
}

// Wrap a packfile in sideband band-1 packets, chunked to the pkt-line limit.
function framePackSideband(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const maxChunk = 65515;
  if (pack.length === 0) return [pktLine(Buffer.concat([SIDEBAND_BAND1, Buffer.alloc(0)]))];
  for (let start = 0; start < pack.length; start += maxChunk) {
    const end = Math.min(pack.length, start + maxChunk);
    packets.push(pktLine(Buffer.concat([SIDEBAND_BAND1, pack.subarray(start, end)])));
  }
  return packets;
}

// Answer a v2 ls-refs command for `repo`, honouring peel / symrefs /
// unborn flags and server-side ref-prefix filtering.
function answerLsRefs(store: Store, repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (trimmed === 'peel') peel = true;
    else if (trimmed === 'symrefs') symrefs = true;
    else if (trimmed === 'unborn') unborn = true;
    else if (trimmed.startsWith('ref-prefix ')) prefixes.push(trimmed.slice(11));
  }
  const out: Buffer[] = [];
  const emit = (oid: string, ref: string, extra: string): void => {
    if (prefixes.length > 0 && !prefixes.some((p) => ref.startsWith(p))) return;
    out.push(pktLine(`${oid} ${ref}${extra}\n`));
  };
  const head = defaultBranchTip(repo);
  const refs = listRefs(repo);
  if (refs.length === 0) {
    // Empty repo: when the client asked for unborn refs, answer with an
    // `unborn HEAD` line; git then skips the fetch entirely. A zero-oid
    // HEAD line instead would make git try to fetch `want 0000...` and
    // choke on the response.
    if (unborn) {
      emit('unborn', 'HEAD', symrefs ? ' symref-target:refs/heads/main' : '');
    } else {
      emit(head, 'HEAD', symrefs ? ' symref-target:refs/heads/main' : '');
    }
    out.push(PKT_FLUSH);
    return Buffer.concat(out);
  }
  emit(head, 'HEAD', symrefs ? ' symref-target:refs/heads/main' : '');
  for (const { ref, oid } of refs) {
    let extra = '';
    const obj = store.object(oid);
    if (peel && obj && obj.type === 'tag') extra += ` peeled:${parseTag(obj.data).object}`;
    emit(oid, ref, extra);
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// Answer a v2 fetch command: plan the fetch, build the pack, and
// return it in sections (acknowledgments, shallow-info, packfile).
// Identical fetches share one cached response (see fetchCache).
function answerFetchV2(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = fetchCacheKey(repo, 'v2', args);
  const cached = fetchCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(store, args.wants, args.haves, args.shallow, args.deepen);
  const objects = collectFetchObjects(store, plan);
  // Filter support: blob:none drops blobs, tree:0 drops trees and blobs.
  let packObjects = objects;
  if (args.filter === 'blob:none') packObjects = objects.filter((o) => o.type !== 'blob');
  else if (args.filter === 'tree:0') packObjects = objects.filter((o) => o.type === 'commit');
  const pack = buildPack(packObjects);
  const sections: Buffer[][] = [];
  // acknowledgments: only when the client sent haves (a negotiation).
  // A real upload-pack sends no such section on a fresh clone, and
  // git's reader then expects 'packfile' as the first section header.
  if (args.haves.length > 0) {
    const ackSection: Buffer[] = [pktLine('acknowledgments\n')];
    const ackLines: string[] = [];
    for (const held of args.haves) {
      if (args.wants.some((w) => store.isAncestor(held, w) || held === w)) ackLines.push(`ACK ${held}\n`);
    }
    if (ackLines.length > 0) {
      for (const line of ackLines) ackSection.push(pktLine(line));
      ackSection.push(pktLine('ready\n'));
    } else {
      ackSection.push(pktLine('NAK\n'));
    }
    sections.push(ackSection);
  }
  // shallow-info, when the plan created or removed a boundary.
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const shallowSection: Buffer[] = [pktLine('shallow-info\n')];
    for (const s of plan.shallow) shallowSection.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) shallowSection.push(pktLine(`unshallow ${s}\n`));
    sections.push(shallowSection);
  }
  // No wanted-refs section: a real upload-pack sends none in clone and
  // fetch flows, and git's reader would die with "expected 'packfile'"
  // if one appeared before the packfile section.
  const packSection: Buffer[] = [pktLine('packfile\n'), ...framePackSideband(pack)];
  sections.push(packSection);
  // Sections are joined with delim packets and the body ends with flush.
  const out: Buffer[] = [];
  sections.forEach((section, index) => {
    out.push(...section);
    out.push(index < sections.length - 1 ? PKT_DELIM : PKT_FLUSH);
  });
  const body = Buffer.concat(out);
  fetchCachePut(cacheKey, body);
  return body;
}

export function handleUploadPackV2(store: Store, repo: Repo, body: Buffer): GitResponse {
  const { lines } = parsePktLines(body, 0);
  const command = lines.find((l) => l.startsWith('command=')) ?? '';
  if (command.startsWith('command=ls-refs')) {
    // The ls-refs arguments follow the delim packet.
    const argLines = argsAfterDelim(body);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: answerLsRefs(store, repo, argLines) };
  }
  if (command.startsWith('command=fetch')) {
    const argLines = argsAfterDelim(body);
    const args = parseFetchArguments(argLines);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: answerFetchV2(store, repo, args) };
  }
  return { status: 400, contentType: 'application/json; charset=utf-8', body: textBuffer('{"message":"Unknown command"}\n') };
}

// ---------------------------------------------------------------- upload-pack v0
export function handleUploadPackV0(store: Store, repo: Repo, body: Buffer): GitResponse {
  const first = parsePktLines(body, 0);
  const second = parsePktLines(body, first.next);
  const args = parseFetchArguments([...first.lines, ...second.lines]);
  const cacheKey = fetchCacheKey(repo, 'v0', args);
  const cached = fetchCache.get(cacheKey);
  if (cached !== undefined) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
  // v0 wants carry features on the first want line; parseFetchArguments
  // already takes only the first token after "want " — the oid.
  const plan = planFetch(store, args.wants, args.haves, args.shallow, args.deepen);
  const objects = collectFetchObjects(store, plan);
  const pack = buildPack(objects);
  const out: Buffer[] = [];
  if (args.haves.some((h) => args.wants.some((w) => store.isAncestor(h, w) || h === w))) {
    for (const held of args.haves) {
      if (args.wants.some((w) => store.isAncestor(held, w) || held === w)) out.push(pktLine(`ACK ${held}\n`));
    }
  } else {
    out.push(pktLine('NAK\n'));
  }
  for (const s of plan.shallow) out.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) out.push(pktLine(`unshallow ${s}\n`));
  for (const packet of framePackSideband(pack)) out.push(packet);
  // The sideband pack stream ends with a flush packet.
  out.push(PKT_FLUSH);
  const responseBody = Buffer.concat(out);
  fetchCachePut(cacheKey, responseBody);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: responseBody };
}

// ---------------------------------------------------------------- receive-pack v0
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  const respond = (lines: string[], useSideband: boolean): GitResponse => {
    // With sideband, the status lines travel INSIDE band-1 packets as a
    // stream of pkt-lines terminated by an inner flush, and the whole
    // response ends with a bare flush. Git's reader reads the flush from
    // the demuxed stream; a bare flush alone is swallowed by the demuxer
    // as end-of-stream and the reader dies with "the remote end hung up".
    const inner = Buffer.concat([...lines.map((l) => pktLine(l)), PKT_FLUSH]);
    let payload: Buffer;
    if (useSideband) {
      const parts: Buffer[] = [];
      const maxChunk = 65515;
      for (let start = 0; start < inner.length; start += maxChunk) {
        const end = Math.min(inner.length, start + maxChunk);
        parts.push(pktLine(Buffer.concat([SIDEBAND_BAND1, inner.subarray(start, end)])));
      }
      payload = Buffer.concat(parts);
    } else {
      payload = inner;
    }
    payload = Buffer.concat([payload, PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: payload };
  };
  const parsed = parsePktLines(body, 0);
  const commands: { oldOid: string; newOid: string; ref: string; caps: string }[] = [];
  for (const raw of parsed.lines) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    const [head, caps] = line.split('\0');
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2], caps: caps ?? '' });
  }
  const useSideband = commands.length > 0 && commands[0].caps.includes('side-band-64k');
  const packBytes = body.subarray(parsed.next);
  // Import the pack. A create/update command list always carries one,
  // even an empty 32-byte pack; a delete-only list carries none.
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes);
      // parsePack already hashed every object to find its oid; hand it
      // over instead of hashing the same bytes a second time.
      for (const o of objects) store.storeObject(o.type, o.data, o.oid);
    } catch (caught) {
      unpackError = caught instanceof Error ? caught.message : 'unpack error';
    }
  }
  const lines: string[] = [];
  if (unpackError) {
    lines.push(`unpack ${unpackError}\n`);
    for (const c of commands) lines.push(`ng ${c.ref} unpacker error\n`);
    return respond(lines, useSideband);
  }
  lines.push('unpack ok\n');
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete a ref.
      if (current === undefined) {
        lines.push(`ng ${cmd.ref} cannot delete a ref that does not exist\n`);
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        lines.push(`ng ${cmd.ref} stale info\n`);
      } else {
        repo.refs.delete(cmd.ref);
        lines.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    if (!store.object(cmd.newOid)) {
      lines.push(`ng ${cmd.ref} object not found\n`);
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create a new ref.
      if (current !== undefined) {
        lines.push(`ng ${cmd.ref} already exists\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      lines.push(`ok ${cmd.ref}\n`);
      continue;
    }
    // Update an existing ref: it must fast-forward.
    if (current === undefined) {
      lines.push(`ng ${cmd.ref} cannot update a ref that does not exist\n`);
      continue;
    }
    if (current !== cmd.oldOid) {
      lines.push(`ng ${cmd.ref} stale info\n`);
      continue;
    }
    if (!store.isAncestor(cmd.oldOid, cmd.newOid)) {
      lines.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    lines.push(`ok ${cmd.ref}\n`);
  }
  return respond(lines, useSideband);
}

export function repoNameIsValid(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.endsWith('.git');
}
