// Git smart HTTP: pkt-line framing, packfile parse/build, upload-pack v2+v0,
// receive-pack v0. No git binary anywhere — everything is implemented here on
// node:zlib and node:crypto. Objects are stored verbatim: a clone returns the
// exact bytes that were pushed.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Store, ZERO_OID, ApiError, gitObjectId, parseTree, parseCommit, parseTag, type GitObject } from './store.ts';

// ---------------------------------------------------------------- pkt-lines
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Parse pkt-lines from `buf` starting at `offset`. Stops at flush/end-of-input. */
export function parsePktLines(buf: Buffer, offset = 0): { lines: string[]; next: number; flushed: boolean } {
  const lines: string[] = [];
  let i = offset;
  let flushed = false;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      flushed = true;
      i += 4;
      break;
    }
    if (len < 4 || i + len > buf.length) break;
    lines.push(buf.subarray(i + 4, i + len).toString('utf8'));
    i += len;
  }
  return { lines, next: i, flushed };
}

function sideband(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

function sidebandStream(band: 1, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < data.length; i += CHUNK) {
    out.push(sideband(band, data.subarray(i, Math.min(data.length, i + CHUNK))));
  }
  if (data.length === 0) out.push(sideband(band, Buffer.alloc(0)));
  return out;
}

// ---------------------------------------------------------------- packfiles
const TYPE_CODES: Record<number, GitObject['type'] | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

function readEntryHeader(buf: Buffer, offset: number): { typeCode: number; size: number; next: number } {
  let b = buf[offset];
  const typeCode = (b >> 4) & 0x07;
  let size = b & 0x0f;
  let shift = 4;
  let i = offset + 1;
  while (b & 0x80) {
    b = buf[i];
    size |= (b & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { typeCode, size, next: i };
}

/** Smallest end E in (start, limit] with inflateSync(buf[start:E]) succeeding with the declared size. */
function findZlibEnd(buf: Buffer, start: number, limit: number, declaredSize: number): number {
  let lo = start + 1;
  let hi = limit;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(start, mid));
      if (out.length === declaredSize) {
        found = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (found === -1) throw new ApiError(400, 'Pack entry is not a valid zlib stream');
  return found;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i];
      i += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readDeltaVarint();
  const targetSize = readDeltaVarint();
  if (sourceSize !== base.length) throw new ApiError(400, 'Delta base size mismatch');
  const parts: Buffer[] = [];
  let total = 0;
  while (i < delta.length) {
    const op = delta[i];
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[i]; i += 1; }
      if (op & 0x02) { offset |= delta[i] << 8; i += 1; }
      if (op & 0x04) { offset |= delta[i] << 16; i += 1; }
      if (op & 0x08) { offset |= delta[i] << 24; i += 1; }
      if (op & 0x10) { size = delta[i]; i += 1; }
      if (op & 0x20) { size |= delta[i] << 8; i += 1; }
      if (op & 0x40) { size |= delta[i] << 16; i += 1; }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(i, i + op));
      total += op;
      i += op;
    } else {
      throw new ApiError(400, 'Delta opcode 0 is invalid');
    }
  }
  if (total !== targetSize) throw new ApiError(400, 'Delta output size mismatch');
  return Buffer.concat(parts);
}

export interface ParsedPackObject {
  oid: string;
  type: GitObject['type'];
  data: Buffer;
}

export function parsePack(buf: Buffer): ParsedPackObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new ApiError(400, 'Not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new ApiError(400, 'Unsupported pack version');
  const count = buf.readUInt32BE(8);
  // Trailer: last 20 bytes must be the SHA-1 of all preceding bytes.
  if (buf.length < 32) throw new ApiError(400, 'Packfile too short');
  const trailerSum = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  if (trailerSum !== buf.subarray(buf.length - 20).toString('hex')) throw new ApiError(400, 'Packfile trailer checksum mismatch');
  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  let offset = 12;
  const end = buf.length - 20;
  for (let n = 0; n < count; n += 1) {
    if (offset >= end) throw new ApiError(400, 'Packfile truncated');
    const entryOffset = offset;
    const { typeCode, size, next } = readEntryHeader(buf, offset);
    offset = next;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA base offset varint
      let b = buf[offset];
      offset += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = buf[offset];
        offset += 1;
        value = ((value + 1) << 7) + (b & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const dataEnd = findZlibEnd(buf, offset, end, size);
    // Delta entries store the *delta* bytes; their declared size is the delta size.
    // For non-delta entries the declared size is the object size. findZlibEnd verifies
    // the inflated length equals the declared size only for non-delta entries; for
    // deltas the inflated stream IS the delta and its length is the declared size too.
    const data = inflateSync(buf.subarray(offset, dataEnd));
    raw.push({ offset: entryOffset, typeCode, size, data, baseOffset, baseOid });
    offset = dataEnd;
  }
  // Resolve deltas (recursively; entries may reference earlier entries or the store).
  const resolved = new Map<number, ParsedPackObject>();
  const resolve = (entry: RawEntry, seen: Set<number>): ParsedPackObject => {
    if (resolved.has(entry.offset)) return resolved.get(entry.offset) as ParsedPackObject;
    if (seen.has(entry.offset)) throw new ApiError(400, 'Delta cycle in packfile');
    seen.add(entry.offset);
    const kind = TYPE_CODES[entry.typeCode];
    if (kind === 'ofs-delta' || kind === 'ref-delta') {
      let base: ParsedPackObject | undefined;
      if (kind === 'ofs-delta') {
        const baseEntry = raw.find((r) => r.offset === entry.baseOffset);
        if (baseEntry) base = resolve(baseEntry, seen);
      } else if (entry.baseOid) {
        // The client sends plain objects only, so a REF_DELTA base in the same
        // pack is a plain entry whose oid is its git id; it may also already
        // live in the store (a thin pack).
        const baseEntry = raw.find((r) => {
          const k = TYPE_CODES[r.typeCode];
          return k !== 'ofs-delta' && k !== 'ref-delta' && gitObjectId(k as GitObject['type'], r.data) === entry.baseOid;
        });
        if (baseEntry) base = resolve(baseEntry, seen);
      }
      if (!base) throw new ApiError(400, 'Delta base is not in the pack');
      const data = applyDelta(base.data, entry.data);
      const obj: ParsedPackObject = { oid: gitObjectId(base.type, data), type: base.type, data };
      resolved.set(entry.offset, obj);
      return obj;
    }
    const type = kind as GitObject['type'];
    const obj: ParsedPackObject = { oid: gitObjectId(type, entry.data), type, data: entry.data };
    resolved.set(entry.offset, obj);
    return obj;
  };
  return raw.map((r) => resolve(r, new Set()));
}

export function checkPackTrailer(buf: Buffer): boolean {
  if (buf.length < 32) return false;
  const sum = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  return sum === buf.subarray(buf.length - 20).toString('hex');
}

/** Build a packfile (version 2, full objects only, no deltas). */
export function buildPack(objects: ParsedPackObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    // Entry header varint
    const headerBytes: number[] = [];
    let size = obj.data.length;
    let b = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) b |= 0x80;
    headerBytes.push(b);
    while (size > 0) {
      b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- fetch planning
export interface FetchPlan {
  /** Commits to include (objects + their trees/blobs). */
  commits: string[];
  /** Extra non-commit objects to include (e.g. tag objects for wanted tags). */
  extras: string[];
  /** New shallow boundaries (commits whose parents are NOT included). */
  shallow: string[];
  /** Old shallow boundaries that are no longer boundaries. */
  unshallow: string[];
}

/**
 * Plan a fetch: walk from `wants` (commit/tag oids), skipping everything the
 * client already holds (haves + their ancestors), honouring `deepen`.
 */
export function planFetch(
  store: Store,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  deepen: number | null,
): FetchPlan {
  const haveCommits = new Set<string>();
  for (const h of haves) {
    for (const c of store.commitChain(h)) haveCommits.add(c);
    haveCommits.add(h);
  }
  const included = new Map<string, number>(); // commit oid -> depth (want depth 1)
  const extras: string[] = [];
  const queue: { oid: string; depth: number }[] = [];
  for (const w of wants) {
    const obj = store.object(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extras.push(w);
      const target = parseTag(obj.data).object;
      queue.push({ oid: target, depth: 1 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: w, depth: 1 });
    }
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = store.commitOf(oid);
    if (!commit) continue;
    const held = haveCommits.has(oid);
    if (deepen !== null) {
      if (depth <= deepen && !held) included.set(oid, depth);
      if (depth < deepen || (depth === deepen && held)) {
        // Traverse parents while we still have depth budget, or through a held
        // tip (deepen past what the client holds).
        if (depth < deepen || held) {
          for (const p of commit.parents) queue.push({ oid: p, depth: depth + 1 });
        }
      }
    } else {
      if (!held) {
        included.set(oid, depth);
        for (const p of commit.parents) queue.push({ oid: p, depth: depth + 1 });
      }
    }
  }
  // Shallow boundaries: included commits at the depth limit, plus old boundaries
  // that remain boundaries (their parent is neither included nor held... their
  // parent is unknown to the client).
  const shallow: string[] = [];
  if (deepen !== null) {
    for (const [oid, depth] of included) {
      if (depth === deepen) shallow.push(oid);
    }
    for (const b of clientShallow) {
      if (included.has(b)) continue;
      if (haveCommits.has(b)) {
        // Still a boundary if its parent is not included and not held.
        const c = store.commitOf(b);
        const parentKnown = c ? c.parents.some((p) => included.has(p) || haveCommits.has(p)) : false;
        if (!parentKnown) shallow.push(b);
      }
    }
  }
  const unshallow: string[] = [];
  if (deepen !== null) {
    for (const b of clientShallow) {
      const c = store.commitOf(b);
      if (!c) continue;
      // No longer a boundary when its parent is now included.
      if (c.parents.some((p) => included.has(p))) unshallow.push(b);
    }
  }
  // Closure of included commits: commits + their trees/blobs (+ tag targets).
  const commits = [...included.keys()];
  return { commits, extras, shallow, unshallow };
}

/** All objects (as pack entries) for the fetch plan, in a stable order. */
export function collectFetchObjects(store: Store, plan: FetchPlan): ParsedPackObject[] {
  const wanted = new Map<string, ParsedPackObject>();
  const addObject = (oid: string): void => {
    const o = store.object(oid);
    if (o && !wanted.has(oid)) wanted.set(oid, { oid, type: o.type, data: o.data });
  };
  const addTree = (treeOid: string): void => {
    const o = store.object(treeOid);
    if (!o || o.type !== 'tree') return;
    addObject(treeOid);
    for (const e of parseTree(o.data)) {
      if (e.mode === '40000') addTree(e.oid);
      else if (e.mode !== '160000') addObject(e.oid);
    }
  };
  for (const extra of plan.extras) {
    addObject(extra);
    const o = store.object(extra);
    if (o && o.type === 'tag') {
      const target = parseTag(o.data).object;
      const t = store.object(target);
      if (t && t.type === 'commit') {
        addObject(target);
        const c = parseCommit(t.data);
        addTree(c.tree);
      }
    }
  }
  for (const commitOid of plan.commits) {
    addObject(commitOid);
    const c = store.commitOf(commitOid);
    if (c) addTree(c.tree);
  }
  return [...wanted.values()];
}
