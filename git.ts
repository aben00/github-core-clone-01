// Git smart-HTTP plumbing: pkt-line framing, packfile parsing and
// building, upload-pack (v2 and v0) and receive-pack (v0). There is no
// git binary anywhere in this forge — every byte of the protocol is
// implemented here on top of node:zlib and node:crypto. Objects are
// stored verbatim, so a clone returns exactly the bytes that were pushed.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Store, ZERO_OID, ApiError, gitObjectId, parseTree, parseCommit, parseTag, type GitObject } from './store.ts';

// ------------------------------------------------------------------ pkt-lines
//
// A pkt-line is four ASCII hex digits giving the total length of the
// packet (header included), followed by the payload. A length of zero
// is a flush packet. The maximum packet is 65520 bytes in total.

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = body.length + 4;
  const head = Buffer.from(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

// Parse pkt-lines out of `buf` from `offset`. Stops at a flush packet
// or at the end of the buffer, and reports where parsing stopped.
export function parsePktLines(buf: Buffer, offset = 0): { lines: string[]; next: number; flushed: boolean } {
  const lines: string[] = [];
  let cursor = offset;
  let flushed = false;
  while (cursor + 4 <= buf.length) {
    const length = parseInt(buf.subarray(cursor, cursor + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      flushed = true;
      cursor += 4;
      break;
    }
    if (length < 4 || cursor + length > buf.length) break;
    lines.push(buf.subarray(cursor + 4, cursor + length).toString('utf8'));
    cursor += length;
  }
  return { lines, next: cursor, flushed };
}

// One sideband packet: a pkt-line whose first payload byte is the band.
function sideband(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

// Split `data` into sideband packets of at most 65515 payload bytes.
function sidebandStream(band: 1, data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const maxChunk = 65515;
  for (let start = 0; start < data.length; start += maxChunk) {
    const end = Math.min(data.length, start + maxChunk);
    packets.push(sideband(band, data.subarray(start, end)));
  }
  if (data.length === 0) packets.push(sideband(band, Buffer.alloc(0)));
  return packets;
}

// ------------------------------------------------------------------ packfiles
//
// Pack entry type codes, as the wire format numbers them.

const PACK_TYPE_NAMES: Record<number, GitObject['type'] | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

// Decode one pack entry header: type code, declared size, offset past it.
function decodeObjectHeader(buf: Buffer, offset: number): { typeCode: number; size: number; next: number } {
  let byte = buf[offset];
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let cursor = offset + 1;
  while (byte & 0x80) {
    byte = buf[cursor];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    cursor += 1;
  }
  return { typeCode, size, next: cursor };
}

// Find the smallest end E in (start, limit] such that inflating
// buf[start:E] succeeds and yields exactly `declaredSize` bytes.
// The zlib stream has no length prefix, so binary search is the
// way to locate its end without guessing.
function locateZlibEnd(buf: Buffer, start: number, limit: number, declaredSize: number): number {
  let lo = start + 1;
  let hi = limit;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const inflated = inflateSync(buf.subarray(start, mid));
      if (inflated.length === declaredSize) {
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

// Apply a delta instruction stream to `base`, returning the result.
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let cursor = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[cursor];
      cursor += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new ApiError(400, 'Delta base size mismatch');
  const chunks: Buffer[] = [];
  let produced = 0;
  while (cursor < delta.length) {
    const op = delta[cursor];
    cursor += 1;
    if (op & 0x80) {
      // Copy from the base object: offset bits 0-3, size bits 4-6.
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[cursor]; cursor += 1; }
      if (op & 0x02) { offset |= delta[cursor] << 8; cursor += 1; }
      if (op & 0x04) { offset |= delta[cursor] << 16; cursor += 1; }
      if (op & 0x08) { offset |= delta[cursor] << 24; cursor += 1; }
      if (op & 0x10) { size = delta[cursor]; cursor += 1; }
      if (op & 0x20) { size |= delta[cursor] << 8; cursor += 1; }
      if (op & 0x40) { size |= delta[cursor] << 16; cursor += 1; }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      // Literal insert of the next `op` bytes from the delta stream.
      chunks.push(delta.subarray(cursor, cursor + op));
      produced += op;
      cursor += op;
    } else {
      throw new ApiError(400, 'Delta opcode 0 is invalid');
    }
  }
  if (produced !== targetSize) throw new ApiError(400, 'Delta output size mismatch');
  return Buffer.concat(chunks);
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
  // The trailer is the last 20 bytes: SHA-1 of everything before it.
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
    const header = decodeObjectHeader(buf, offset);
    offset = header.next;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (header.typeCode === 6) {
      // OFS_DELTA: the base offset is a varint counting backwards.
      let byte = buf[offset];
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[offset];
        offset += 1;
        value = ((value + 1) << 7) + (byte & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (header.typeCode === 7) {
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const dataEnd = locateZlibEnd(buf, offset, end, header.size);
    // For a delta entry the inflated stream is the delta itself, and its
    // length is the declared size; for a plain entry it is the object.
    const data = inflateSync(buf.subarray(offset, dataEnd));
    raw.push({ offset: entryOffset, typeCode: header.typeCode, size: header.size, data, baseOffset, baseOid });
    offset = dataEnd;
  }
  // Resolve deltas recursively. Entries may reference earlier entries in
  // the pack, or an object the store already holds (a thin pack).
  const resolved = new Map<number, ParsedPackObject>();
  const resolve = (entry: RawEntry, seen: Set<number>): ParsedPackObject => {
    if (resolved.has(entry.offset)) return resolved.get(entry.offset) as ParsedPackObject;
    if (seen.has(entry.offset)) throw new ApiError(400, 'Delta cycle in packfile');
    seen.add(entry.offset);
    const kind = PACK_TYPE_NAMES[entry.typeCode];
    if (kind === 'ofs-delta' || kind === 'ref-delta') {
      let base: ParsedPackObject | undefined;
      if (kind === 'ofs-delta') {
        const baseEntry = raw.find((r) => r.offset === entry.baseOffset);
        if (baseEntry) base = resolve(baseEntry, seen);
      } else if (entry.baseOid) {
        // A REF_DELTA base in the same pack is a plain entry whose git id
        // is the base oid; the client sends plain objects only, so that
        // is how thin-pack bases are found here.
        const baseEntry = raw.find((r) => {
          const k = PACK_TYPE_NAMES[r.typeCode];
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

// Build a packfile (version 2, full objects only, no deltas).
export function buildPack(objects: ParsedPackObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    const typeCode = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    // Entry header as a varint: low nibble is the size, bits 4-6 the type.
    const headerBytes: number[] = [];
    let remaining = obj.data.length;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let nextByte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) nextByte |= 0x80;
      headerBytes.push(nextByte);
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
  // Commits to include (each with its tree and blobs).
  commits: string[];
  // Extra non-commit objects (for example a tag object for a wanted tag).
  extras: string[];
  // New shallow boundaries: commits whose parents are NOT included.
  shallow: string[];
  // Old shallow boundaries that are no longer boundaries.
  unshallow: string[];
  // Objects the client already holds: never re-send them.
  heldObjects: Set<string>;
}

// Plan a fetch: walk out from `wants` (commit or tag oids), skipping
// everything the client already holds (haves and their ancestors),
// and honouring `deepen` when the client asked for a shallow fetch.
export function planFetch(
  store: Store,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  deepen: number | null,
): FetchPlan {
  // What the client already holds: the haves plus their tree closures.
  // The walk stops at shallow boundaries — a shallow clone holds its
  // boundary commit and its tree, not the boundary's parents (that is
  // what deepen is for). The same set drives both the commit walk and
  // the pack's object filter, so a fetch never re-sends an held object.
  const held = store.reachableObjects(haves, new Set(clientShallow));
  const haveCommits = held.commits;
  const included = new Map<string, number>(); // commit oid -> depth, wants at depth 1
  const extras: string[] = [];
  const queue: { oid: string; depth: number }[] = [];
  for (const wanted of wants) {
    const obj = store.object(wanted);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extras.push(wanted);
      const target = parseTag(obj.data).object;
      queue.push({ oid: target, depth: 1 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: wanted, depth: 1 });
    }
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as { oid: string; depth: number };
    const { oid, depth } = current;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const parsed = store.commitOf(oid);
    if (!parsed) continue;
    const alreadyHeld = haveCommits.has(oid);
    if (deepen !== null) {
      if (depth <= deepen && !alreadyHeld) included.set(oid, depth);
      // Keep walking while there is depth budget left, or through a
      // held tip (deepen past what the client already holds).
      if (depth < deepen || alreadyHeld) {
        for (const parent of parsed.parents) queue.push({ oid: parent, depth: depth + 1 });
      }
    } else if (!alreadyHeld) {
      included.set(oid, depth);
      for (const parent of parsed.parents) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  // Shallow boundaries: included commits at the depth limit, plus old
  // boundaries that are still boundaries (their parent is neither
  // included nor held, so the client still does not know it).
  const shallow: string[] = [];
  if (deepen !== null) {
    for (const [oid, depth] of included) {
      if (depth === deepen) shallow.push(oid);
    }
    for (const boundary of clientShallow) {
      if (included.has(boundary)) continue;
      if (haveCommits.has(boundary)) {
        const parsed = store.commitOf(boundary);
        const parentKnown = parsed ? parsed.parents.some((p) => included.has(p) || haveCommits.has(p)) : false;
        if (!parentKnown) shallow.push(boundary);
      }
    }
  }
  const unshallow: string[] = [];
  if (deepen !== null) {
    for (const boundary of clientShallow) {
      const parsed = store.commitOf(boundary);
      if (!parsed) continue;
      // A boundary stops being one when its parent is now included.
      if (parsed.parents.some((p) => included.has(p))) unshallow.push(boundary);
    }
  }
  const commits = [...included.keys()];
  return { commits, extras, shallow, unshallow, heldObjects: held.objects };
}

// Every object (as a pack entry) for the fetch plan, in a stable order.
// Objects the client already holds are left out: a re-sent tree or
// blob fails the incremental-fetch checks. A held tree's whole subtree
// is held too (same oid, same content), so it is skipped without
// descending into it.
export function collectFetchObjects(store: Store, plan: FetchPlan): ParsedPackObject[] {
  const wanted = new Map<string, ParsedPackObject>();
  const addObject = (oid: string): void => {
    if (plan.heldObjects.has(oid)) return;
    const found = store.object(oid);
    if (found && !wanted.has(oid)) wanted.set(oid, { oid, type: found.type, data: found.data });
  };
  const addTree = (treeOid: string): void => {
    if (plan.heldObjects.has(treeOid)) return;
    const found = store.object(treeOid);
    if (!found || found.type !== 'tree') return;
    addObject(treeOid);
    for (const entry of parseTree(found.data)) {
      if (entry.mode === '40000') addTree(entry.oid);
      else if (entry.mode !== '160000') addObject(entry.oid);
    }
  };
  for (const extra of plan.extras) {
    addObject(extra);
    const found = store.object(extra);
    if (found && found.type === 'tag') {
      const target = parseTag(found.data).object;
      const targetObj = store.object(target);
      if (targetObj && targetObj.type === 'commit') {
        addObject(target);
        const parsed = parseCommit(targetObj.data);
        addTree(parsed.tree);
      }
    }
  }
  for (const commitOid of plan.commits) {
    addObject(commitOid);
    const parsed = store.commitOf(commitOid);
    if (parsed) addTree(parsed.tree);
  }
  return [...wanted.values()];
}
