// Git object model, packfile codec, pkt-line codec and the reachability / merge / diff
// primitives the forge is built on. Dependency-free: node:crypto for SHA-1, node:zlib
// for the pack streams. Plain objects only in packs (no deltas): the client resolves
// every object either way, and a delta-free pack is always a legal answer.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}
export type ObjectLookup = (oid: string) => GitObject | undefined;

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/** git's object id: SHA-1 over `<type> <size>\0` + bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';

export function buildCommit(fields: BuildCommitFields): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const author = `${fields.author ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? CONFORMANCE_IDENTITY} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > 65516) throw new Error(`pkt-line payload is ${data.length} bytes, over the 65516-byte maximum`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines into data payloads plus control markers. */
export type DecodedPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

export function decodePktLines(bytes: Buffer): DecodedPacket[] {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > bytes.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

// ---------------------------------------------------------------------------------------------
// packfile read / write (plain objects, no deltas)
// ---------------------------------------------------------------------------------------------

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
  readonly checksumOk: boolean;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = deltaBuffer[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (deltaBuffer[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (deltaBuffer[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA against the pack itself or `resolveBase`. */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;
  if (!checksumOk) throw new Error('pack trailer does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  let deltaCount = 0;
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { _resolved?: { type: GitObjectType; data: Buffer; oid: string } })._resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as unknown as { _resolved?: { type: GitObjectType; data: Buffer; oid: string } })._resolved = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, deltaCount, checksumOk };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------------------------
// pack-object cache (writePack) and commit-view memo (fetchPlan / collectReachable)
// ---------------------------------------------------------------------------------------------

/**
 * A pack object's wire bytes, keyed by the object id (SHA-1 over `<type> <size>\0` + data):
 * the header and the deflated payload. Objects are content-addressed and immutable, and
 * deflateSync is deterministic, so a cached entry is byte-identical to a fresh deflate.
 * The clone workload packs the same tip objects 50 times a round; without this, every pack
 * re-deflates every object from scratch. Bounded so a long-lived process cannot grow it
 * without limit (oldest entries go first).
 */
interface CachedPackObject {
  readonly header: Buffer;
  readonly deflated: Buffer;
  readonly bytes: number;
}
const PACK_CACHE_MAX_ENTRIES = 8192;
const PACK_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const packObjectCache = new Map<string, CachedPackObject>();
let packCacheBytes = 0;

function cachedPackObject(type: GitObjectType, data: Buffer): CachedPackObject {
  const oid = hashObject(type, data);
  const hit = packObjectCache.get(oid);
  if (hit !== undefined) return hit;
  const header = writePackObjectHeader(type, data.length);
  const deflated = deflateSync(data);
  const entry: CachedPackObject = { header, deflated, bytes: header.length + deflated.length };
  while (
    (packObjectCache.size >= PACK_CACHE_MAX_ENTRIES || packCacheBytes + entry.bytes > PACK_CACHE_MAX_BYTES) &&
    packObjectCache.size > 0
  ) {
    const oldest = packObjectCache.keys().next().value as string;
    const removed = packObjectCache.get(oldest) as CachedPackObject;
    packCacheBytes -= removed.bytes;
    packObjectCache.delete(oldest);
  }
  packObjectCache.set(oid, entry);
  packCacheBytes += entry.bytes;
  return entry;
}

/**
 * The parsed view of a commit, memoized by oid. Objects are immutable, so a cached view never
 * goes stale; a fetch used to parse the same tip commit three times (BFS, shallow boundary,
 * tree) and every concurrent clone parsed it again. Bounded, oldest first.
 */
const COMMIT_VIEW_CACHE_MAX = 8192;
const commitViewCache = new Map<string, CommitView>();

function cachedCommitView(oid: string, object: GitObject | undefined): CommitView | undefined {
  const hit = commitViewCache.get(oid);
  if (hit !== undefined) return hit;
  if (!object || object.type !== 'commit') return undefined;
  const view = parseCommit(object.data);
  if (commitViewCache.size >= COMMIT_VIEW_CACHE_MAX) {
    const oldest = commitViewCache.keys().next().value as string;
    commitViewCache.delete(oldest);
  }
  commitViewCache.set(oid, view);
  return view;
}

export interface GitObjectInput {
  readonly type: GitObjectType;
  readonly data: Uint8Array;
}

/** Build a packfile from plain objects (no deltas). The trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<GitObjectInput>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    const cached = cachedPackObject(object.type, data);
    parts.push(cached.header, cached.deflated);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// reachability, shallow fetch, merge-base, trees
// ---------------------------------------------------------------------------------------------

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries (gitlinks
 * skipped), tag -> its target, blob -> nothing. Throws on a missing object unless
 * `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean; cutAt?: ReadonlySet<string> } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = cachedCommitView(oid, object);
      if (commit !== undefined) {
        queue.push(commit.tree);
        // A cut commit is a shallow boundary: the client holds the commit and its tree,
        // but not its parents. Do not follow the parents past the cut.
        if (options.cutAt?.has(oid)) continue;
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Flatten a tree into path -> {mode, oid} (blobs and subtrees; gitlinks skipped). */
export function flattenTree(treeOid: string, lookup: ObjectLookup): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode === '160000') continue;
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/**
 * The objects a fetch must send, for wants/haves/shallow/depth. Returns the object ids to
 * send, the new shallow boundaries and the boundaries that stopped being shallow.
 */
export function fetchPlan(
  wants: readonly string[],
  lookup: ObjectLookup,
  options: { haves?: readonly string[]; shallow?: readonly string[]; depth?: number } = {},
): { objects: Set<string>; shallow: string[]; unshallow: string[] } {
  // Expand tag wants to their targets (tags themselves are always sent when wanted).
  const tagObjects = new Set<string>();
  const commitWants: string[] = [];
  const extraWants: string[] = [];
  const expand = (oid: string, seenTags: Set<string>): void => {
    const object = lookup(oid);
    if (!object) return;
    if (object.type === 'tag') {
      if (seenTags.has(oid)) return;
      seenTags.add(oid);
      tagObjects.add(oid);
      expand(parseTag(object.data).object, seenTags);
    } else if (object.type === 'commit') {
      commitWants.push(oid);
    } else {
      extraWants.push(oid);
    }
  };
  for (const want of wants) expand(want, new Set<string>());

  const depth = options.depth;
  // Distance of each commit from the wants, by BFS over parents.
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const oid of commitWants) {
    if (!distance.has(oid)) {
      distance.set(oid, 0);
      queue.push(oid);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++] as string;
    const d = distance.get(oid) as number;
    if (depth !== undefined && d + 1 >= depth) continue; // parents would be at/over the cut
    const commit = cachedCommitView(oid, lookup(oid));
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (!distance.has(parent)) {
        distance.set(parent, d + 1);
        queue.push(parent);
      }
    }
  }
  // Included commits: distance < depth (or all, when no depth).
  const included = new Set<string>();
  for (const [oid, d] of distance) {
    if (depth === undefined || d < depth) included.add(oid);
  }
  // New shallow boundaries: the deepest included commits that still have parents.
  const shallow: string[] = [];
  if (depth !== undefined) {
    for (const oid of included) {
      if ((distance.get(oid) as number) !== depth - 1) continue;
      const commit = cachedCommitView(oid, lookup(oid));
      if (!commit) continue;
      if (commit.parents.length > 0) shallow.push(oid);
    }
    shallow.sort();
  }
  // Boundaries that stopped being shallow: old boundaries now fully included (every parent in).
  const unshallow: string[] = [];
  for (const old of options.shallow ?? []) {
    if (!included.has(old)) continue;
    const commit = cachedCommitView(old, lookup(old));
    if (!commit) continue;
    if (commit.parents.every((parent) => included.has(parent))) unshallow.push(old);
  }
  unshallow.sort();

  // Objects to send: tags, extra wants, included commits + their trees/blobs.
  const send = new Set<string>(tagObjects);
  for (const oid of extraWants) send.add(oid);
  for (const oid of included) {
    send.add(oid);
    const commit = cachedCommitView(oid, lookup(oid));
    if (!commit) continue;
    const tree = commit.tree;
    send.add(tree);
    // One walk of the tree: collect every subtree oid and every blob entry oid.
    // (flattenTree plus a second subtree walk used to parse each tree object twice.)
    const treeQueue = [tree];
    const seenTrees = new Set<string>([tree]);
    while (treeQueue.length) {
      const treeOid = treeQueue.pop() as string;
      const treeObject = lookup(treeOid);
      if (!treeObject || treeObject.type !== 'tree') continue;
      for (const entry of parseTree(treeObject.data)) {
        if (entry.mode === '160000') continue;
        if (entry.mode === '40000') {
          if (!seenTrees.has(entry.oid)) {
            seenTrees.add(entry.oid);
            send.add(entry.oid);
            treeQueue.push(entry.oid);
          }
        } else {
          send.add(entry.oid);
        }
      }
    }
  }
  // Subtract what the client already has. A shallow boundary is a cut: the client holds
  // the boundary commit and its tree, but none of its ancestors, so the parents of a
  // shallow commit must not be subtracted (a deepen has to deliver them).
  const held = new Set<string>();
  const shallowSet = new Set(options.shallow ?? []);
  for (const root of [...(options.haves ?? []), ...(options.shallow ?? [])]) {
    for (const oid of collectReachable([root], lookup, { allowMissing: true, cutAt: shallowSet })) held.add(oid);
  }
  for (const oid of held) send.delete(oid);
  return { objects: send, shallow, unshallow };
}

/** The merge-base of two commits: the common ancestor with the greatest depth. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  // Breadth-first distances from each tip, so a commit's depth is the length of the
  // shortest path to it. The merge base is the common ancestor with the smallest
  // combined distance: the nearest common ancestor, the one neither side has moved
  // past. (The farthest common ancestor would make every file both sides touched
  // since the branch point look like a conflict.)
  const depthOf = (root: string): Map<string, number> => {
    const depth = new Map<string, number>();
    const queue: Array<{ oid: string; d: number }> = [{ oid: root, d: 0 }];
    while (queue.length) {
      const { oid, d } = queue.shift() as { oid: string; d: number };
      if (depth.has(oid)) continue;
      depth.set(oid, d);
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, d: d + 1 });
    }
    return depth;
  };
  const depthA = depthOf(a);
  const depthB = depthOf(b);
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const [oid, da] of depthA) {
    const db = depthB.get(oid);
    if (db === undefined) continue;
    const score = da + db;
    if (score < bestDepth) {
      bestDepth = score;
      best = oid;
    }
  }
  return best;
}

/** The ancestors of a commit (itself included), newest-first by discovery order. */
export function ancestorsOf(root: string, lookup: ObjectLookup): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid) || !isObjectId(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

export interface DiffEntry {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted';
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** LCS length of two line arrays (DP, capped: over the cap, prefix/suffix only). */
function lcsLength(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (n > 1000 || m > 1000) {
    let prefix = 0;
    while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix += 1;
    return prefix + suffix;
  }
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[m];
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n').filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ''));
  const newLines = newText === '' ? [] : newText.split('\n').filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ''));
  const common = lcsLength(oldLines, newLines);
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/** The file diff between two trees, by path. */
export function diffTrees(
  baseTreeOid: string | null,
  headTreeOid: string | null,
  lookup: ObjectLookup,
): DiffEntry[] {
  const base = baseTreeOid === null ? new Map() : flattenTree(baseTreeOid, lookup);
  const head = headTreeOid === null ? new Map() : flattenTree(headTreeOid, lookup);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: DiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const oldText = lookup(b.oid)?.data.toString('utf8') ?? '';
      out.push({ path, status: 'deleted', oldOid: b.oid, newOid: null, additions: 0, deletions: countLines(oldText), changes: countLines(oldText) });
    } else if (!b && h) {
      const newText = lookup(h.oid)?.data.toString('utf8') ?? '';
      const additions = countLines(newText);
      out.push({ path, status: 'added', oldOid: null, newOid: h.oid, additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const oldText = lookup(b.oid)?.data.toString('utf8') ?? '';
      const newText = lookup(h.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid, additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Build the tree that results from setting `path` to `blobOid` (or deleting it) under `baseTreeOid`. */
export function setPathInTree(
  baseTreeOid: string | null,
  path: string,
  blobOid: string | null,
  lookup: ObjectLookup,
  store: (type: GitObjectType, data: Buffer) => string,
): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) throw new Error('empty path');
  const build = (treeOid: string | null, depth: number): string | null => {
    const entries = new Map<string, TreeEntry>();
    if (treeOid !== null) {
      const object = lookup(treeOid);
      if (object && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const name = segments[depth] as string;
    if (depth === segments.length - 1) {
      if (blobOid === null) entries.delete(name);
      else entries.set(name, { mode: '100644', name, oid: blobOid });
    } else {
      const child = entries.get(name);
      const childTree = child && child.mode === '40000' ? child.oid : null;
      const next = build(childTree, depth + 1);
      if (next === null) entries.delete(name);
      else entries.set(name, { mode: '40000', name, oid: next });
    }
    if (entries.size === 0) return null;
    const data = buildTree([...entries.values()]);
    return store('tree', data);
  };
  const result = build(baseTreeOid, 0);
  if (result === null) {
    // An empty tree: store the canonical empty tree.
    return store('tree', buildTree([]));
  }
  return result;
}

/**
 * The three-way merge of trees, file by file: a path takes the head version when head changed
 * it against the base, else the base version. Returns the merged tree oid, or the conflicting
 * paths when both sides changed the same path differently.
 */
export function threeWayMergeTrees(
  mergeBaseTreeOid: string | null,
  baseTreeOid: string | null,
  headTreeOid: string | null,
  lookup: ObjectLookup,
  store: (type: GitObjectType, data: Buffer) => string,
): { tree: string; conflicts: string[] } {
  const ancestor = mergeBaseTreeOid === null ? new Map() : flattenTree(mergeBaseTreeOid, lookup);
  const base = baseTreeOid === null ? new Map() : flattenTree(baseTreeOid, lookup);
  const head = headTreeOid === null ? new Map() : flattenTree(headTreeOid, lookup);
  const conflicts: string[] = [];
  const merged = new Map<string, { mode: string; oid: string }>();
  const paths = new Set<string>([...ancestor.keys(), ...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path);
    const b = base.get(path);
    const h = head.get(path);
    const headChanged = (a?.oid ?? null) !== (h?.oid ?? null);
    const baseChanged = (a?.oid ?? null) !== (b?.oid ?? null);
    if (headChanged && baseChanged && (b?.oid ?? null) !== (h?.oid ?? null)) {
      conflicts.push(path);
      continue;
    }
    const winner = headChanged ? h : b;
    if (winner) merged.set(path, winner);
  }
  // Rebuild nested trees from the flat map.
  const root = buildTreeFromFlat(merged, store);
  return { tree: root, conflicts };
}

function buildTreeFromFlat(
  flat: Map<string, { mode: string; oid: string }>,
  store: (type: GitObjectType, data: Buffer) => string,
): string {
  interface DirNode {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i] as string);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i] as string, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const storeNode = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: storeNode(child) });
    return store('tree', buildTree(entries));
  };
  return storeNode(root);
}
