// Git smart-HTTP handlers: info/refs advertisements, upload-pack (v2 and v0),
// receive-pack (v0). Wired into app.ts; shares the Store with REST/GraphQL/MCP.

import { Store, ZERO_OID, ApiError, parseTag, type Repo } from './store.ts';
import {
  pktLine, PKT_FLUSH, PKT_DELIM, parsePktLines, parsePack, buildPack,
  planFetch, collectFetchObjects,
} from './git.ts';

const UPLOAD_CAPS_V0 = 'side-band-64k multi_ack_detailed thin-pack ofs-delta shallow agent=makefun-forge/1.0 symref=HEAD:refs/heads/main';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';
const AGENT = 'makefun-forge/1.0';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function buf(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

function refLines(repo: Repo): { ref: string; oid: string; tagTarget?: string }[] {
  const out: { ref: string; oid: string; tagTarget?: string }[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) {
    out.push({ ref, oid });
  }
  return out;
}

function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

// The peeled-tag lines need the store: build the v0 body with tag peeling here.
function v0AdvertisementFull(store: Store, repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const caps = service === 'upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [];
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid(repo)} HEAD\0${caps}\n`));
    for (const { ref, oid } of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const obj = store.object(oid);
      if (obj && obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        parts.push(pktLine(`${target} ${ref}^{}\n`));
      }
    }
  }
  // The advertisement ends with a flush packet: without it git waits for more
  // lines, the body ends, and it reports "the remote end hung up".
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'ls-refs=peel symrefs unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
  ];
  return Buffer.concat([...lines.map((l) => pktLine(l)), PKT_FLUSH]);
}

export function handleInfoRefs(store: Store, repo: Repo | undefined, service: string, gitProtocol: string): GitResponse {
  if (!repo) return { status: 404, contentType: 'application/json; charset=utf-8', body: buf('{"message":"Not Found"}\n') };
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    const body = Buffer.concat([pktLine('# service=git-upload-pack\n'), PKT_FLUSH, v0AdvertisementFull(store, repo, 'upload-pack')]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  if (service === 'git-receive-pack') {
    const body = Buffer.concat([pktLine('# service=git-receive-pack\n'), PKT_FLUSH, v0AdvertisementFull(store, repo, 'receive-pack')]);
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body };
  }
  return { status: 404, contentType: 'application/json; charset=utf-8', body: buf('{"message":"Not Found"}\n') };
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

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [], filter: null };
  for (const line of lines) {
    const l = line.endsWith('\n') ? line.slice(0, -1) : line;
    // v0's first want line carries features after the oid: take the first token.
    // Git sends the same oid twice on a clone (HEAD + its branch): dedupe.
    if (l.startsWith('want ')) {
      const oid = l.slice(5).trim().split(' ')[0];
      if (!args.wants.includes(oid)) args.wants.push(oid);
    } else if (l.startsWith('have ')) args.haves.push(l.slice(5).trim().split(' ')[0]);
    else if (l.startsWith('shallow ')) args.shallow.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) args.deepen = parseInt(l.slice(7).trim(), 10);
    else if (l.startsWith('deepen-since ')) args.deepenSince = parseInt(l.slice(13).trim(), 10);
    else if (l.startsWith('deepen-not ')) args.deepenNot.push(l.slice(11).trim());
    else if (l.startsWith('filter ')) args.filter = l.slice(7).trim();
  }
  return args;
}

/** Lines after the first delim (0001) packet in a v2 request body. */
function linesAfterDelim(body: Buffer): string[] {
  let i = 0;
  while (i + 4 <= body.length) {
    const len = parseInt(body.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) return [];
    if (len === 0) return [];
    if (len === 1) return parsePktLines(body, i + 4).lines;
    if (len < 4 || i + len > body.length) return [];
    i += len;
  }
  return [];
}

function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  if (pack.length === 0) return [pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)]))];
  for (let i = 0; i < pack.length; i += CHUNK) {
    out.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(i, Math.min(pack.length, i + CHUNK))])));
  }
  return out;
}

function lsRefsResponse(store: Store, repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const l = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (l === 'peel') peel = true;
    else if (l === 'symrefs') symrefs = true;
    else if (l === 'unborn') unborn = true;
    else if (l.startsWith('ref-prefix ')) prefixes.push(l.slice(11));
  }
  const out: Buffer[] = [];
  const emit = (oid: string, ref: string, extra: string): void => {
    if (prefixes.length > 0 && !prefixes.some((p) => ref.startsWith(p))) return;
    out.push(pktLine(`${oid} ${ref}${extra}\n`));
  };
  const head = headOid(repo);
  const refs = refLines(repo);
  if (refs.length === 0) {
    // Empty repo: real servers answer `unborn HEAD symref-target:...` when the
    // client asked for it; git then skips the fetch entirely. A zero-oid HEAD
    // line would make git fetch `want 0000...` and choke on the response.
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

function fetchV2Response(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(store, args.wants, args.haves, args.shallow, args.deepen);
  const objects = collectFetchObjects(store, plan);
  // filter support: blob:none drops blobs, tree:0 drops trees+blobs.
  let packObjects = objects;
  if (args.filter === 'blob:none') packObjects = objects.filter((o) => o.type !== 'blob');
  else if (args.filter === 'tree:0') packObjects = objects.filter((o) => o.type === 'commit');
  const pack = buildPack(packObjects);
  const sections: Buffer[][] = [];
  // acknowledgments: ONLY when the client sent haves (negotiation). Real
  // upload-pack sends no such section on a fresh clone, and git's reader then
  // expects 'packfile' as the first section header.
  if (args.haves.length > 0) {
    const ackSection: Buffer[] = [pktLine('acknowledgments\n')];
    const ackLines: string[] = [];
    for (const h of args.haves) {
      if (args.wants.some((w) => store.isAncestor(h, w) || h === w)) ackLines.push(`ACK ${h}\n`);
    }
    if (ackLines.length > 0) {
      for (const l of ackLines) ackSection.push(pktLine(l));
      ackSection.push(pktLine('ready\n'));
    } else {
      ackSection.push(pktLine('NAK\n'));
    }
    sections.push(ackSection);
  }
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const shallowSection: Buffer[] = [pktLine('shallow-info\n')];
    for (const s of plan.shallow) shallowSection.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) shallowSection.push(pktLine(`unshallow ${s}\n`));
    sections.push(shallowSection);
  }
  // No wanted-refs section: real upload-pack sends none in clone/fetch flows,
  // and git's reader would die with "expected 'packfile'" if it appeared.
  // packfile
  const packSection: Buffer[] = [pktLine('packfile\n'), ...sidebandPack(pack)];
  sections.push(packSection);
  // Join sections with delim, end with flush.
  const out: Buffer[] = [];
  sections.forEach((section, i) => {
    out.push(...section);
    out.push(i < sections.length - 1 ? PKT_DELIM : PKT_FLUSH);
  });
  return Buffer.concat(out);
}

export function handleUploadPackV2(store: Store, repo: Repo, body: Buffer): GitResponse {
  const { lines } = parsePktLines(body, 0);
  const command = lines.find((l) => l.startsWith('command=')) ?? '';
  if (command.startsWith('command=ls-refs')) {
    // Args follow the delim packet.
    const argLines = linesAfterDelim(body);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(store, repo, argLines) };
  }
  if (command.startsWith('command=fetch')) {
    const argLines = linesAfterDelim(body);
    const args = parseFetchArgs(argLines);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2Response(store, repo, args) };
  }
  return { status: 400, contentType: 'application/json; charset=utf-8', body: buf('{"message":"Unknown command"}\n') };
}

// ---------------------------------------------------------------- upload-pack v0
export function handleUploadPackV0(store: Store, repo: Repo, body: Buffer): GitResponse {
  const first = parsePktLines(body, 0);
  const second = parsePktLines(body, first.next);
  const args = parseFetchArgs([...first.lines, ...second.lines]);
  // v0 wants carry features on the first want line; strip them in parseFetchArgs
  // (it takes the first token after "want " — the oid — already).
  const plan = planFetch(store, args.wants, args.haves, args.shallow, args.deepen);
  const objects = collectFetchObjects(store, plan);
  const pack = buildPack(objects);
  const out: Buffer[] = [];
  if (args.haves.some((h) => args.wants.some((w) => store.isAncestor(h, w) || h === w))) {
    for (const h of args.haves) {
      if (args.wants.some((w) => store.isAncestor(h, w) || h === w)) out.push(pktLine(`ACK ${h}\n`));
    }
  } else {
    out.push(pktLine('NAK\n'));
  }
  for (const s of plan.shallow) out.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) out.push(pktLine(`unshallow ${s}\n`));
  for (const p of sidebandPack(pack)) out.push(p);
  // The sideband pack stream ends with a flush packet.
  out.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
}

// ---------------------------------------------------------------- receive-pack v0
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  const respond = (lines: string[], sideband: boolean): GitResponse => {
    // With sideband the status lines travel INSIDE band-1 packets as a stream
    // of pkt-lines terminated by an inner flush packet, and the whole response
    // ends with a bare flush. Git's reader reads the flush from the demuxed
    // stream; a bare flush alone is swallowed by the demuxer as end-of-stream
    // and the reader dies with "the remote end hung up unexpectedly".
    const inner = Buffer.concat([...lines.map((l) => pktLine(l)), PKT_FLUSH]);
    let payload: Buffer;
    if (sideband) {
      const parts: Buffer[] = [];
      const CHUNK = 65515;
      for (let i = 0; i < inner.length; i += CHUNK) {
        parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(i, Math.min(inner.length, i + CHUNK))])));
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
  const sideband = commands.length > 0 && commands[0].caps.includes('side-band-64k');
  const packBytes = body.subarray(parsed.next);
  // Import the pack (a create/update list always carries one, even an empty
  // 32-byte pack; a delete-only list carries none).
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes);
      for (const o of objects) store.storeObject(o.type, o.data);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack error';
    }
  }
  const lines: string[] = [];
  if (unpackError) {
    lines.push(`unpack ${unpackError}\n`);
    for (const c of commands) lines.push(`ng ${c.ref} unpacker error\n`);
    return respond(lines, sideband);
  }
  lines.push('unpack ok\n');
  for (const c of commands) {
    const current = repo.refs.get(c.ref);
    if (c.newOid === ZERO_OID) {
      // Delete
      if (current === undefined) {
        lines.push(`ng ${c.ref} cannot delete a ref that does not exist\n`);
      } else if (c.oldOid !== ZERO_OID && c.oldOid !== current) {
        lines.push(`ng ${c.ref} stale info\n`);
      } else {
        repo.refs.delete(c.ref);
        lines.push(`ok ${c.ref}\n`);
      }
      continue;
    }
    if (!store.object(c.newOid)) {
      lines.push(`ng ${c.ref} object not found\n`);
      continue;
    }
    if (c.oldOid === ZERO_OID) {
      // Create
      if (current !== undefined) {
        lines.push(`ng ${c.ref} already exists\n`);
        continue;
      }
      repo.refs.set(c.ref, c.newOid);
      lines.push(`ok ${c.ref}\n`);
      continue;
    }
    // Update: must fast-forward.
    if (current === undefined) {
      lines.push(`ng ${c.ref} cannot update a ref that does not exist\n`);
      continue;
    }
    if (current !== c.oldOid) {
      lines.push(`ng ${c.ref} stale info\n`);
      continue;
    }
    if (!store.isAncestor(c.oldOid, c.newOid)) {
      lines.push(`ng ${c.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(c.ref, c.newOid);
    lines.push(`ok ${c.ref}\n`);
  }
  return respond(lines, sideband);
}

export function repoNameIsValid(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.endsWith('.git');
}
