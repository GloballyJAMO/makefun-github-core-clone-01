// The git object store and pack protocol, in memory, Node stdlib only.
//
// Objects live in a Map keyed by their SHA-1 (the git object id: sha1 of
// "<type> <size>\0" + content). Packs are written without deltas (every
// object whole; clients accept that) and read with full delta support,
// because a pushing client may deltify against objects we already hold.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
const TYPE_NUM: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function objectId(type: GitObjectType, content: Buffer): string {
  const head = Buffer.from(`${type} ${content.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(content).digest('hex');
}

export interface StoredObject {
  readonly type: GitObjectType;
  readonly content: Buffer;
}

export class ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  get(sha: string): StoredObject | undefined {
    return this.objects.get(sha);
  }

  /** Store content as an object; returns its id (storing twice is a no-op). */
  put(type: GitObjectType, content: Buffer): string {
    const sha = objectId(type, content);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, content });
    return sha;
  }

  /** Parse a commit's header lines: { tree, parents, author, committer, rest }. */
  parseCommit(sha: string): { tree: string; parents: string[] } | null {
    const obj = this.objects.get(sha);
    if (!obj || obj.type !== 'commit') return null;
    const text = obj.content.toString('utf8');
    const head = text.split('\n\n', 1)[0];
    let tree = '';
    const parents: string[] = [];
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    }
    return { tree, parents };
  }

  /**
   * Every object reachable from the tips (commits, their trees and blobs,
   * ancestors). With maxDepth set, commit ancestry stops that many
   * generations down (the shallow-clone cut); trees of included commits
   * are always whole.
   */
  closureFrom(tips: string[], maxDepth = Infinity): Set<string> {
    const seen = new Set<string>();
    const queue: { sha: string; depth: number }[] = tips.map((sha) => ({ sha, depth: 0 }));
    while (queue.length > 0) {
      const { sha, depth } = queue.shift()!;
      if (seen.has(sha)) continue;
      const obj = this.objects.get(sha);
      if (!obj) continue;
      seen.add(sha);
      if (obj.type === 'commit') {
        const parsed = this.parseCommit(sha);
        if (parsed) {
          if (parsed.tree) queue.push({ sha: parsed.tree, depth });
          if (depth < maxDepth) for (const p of parsed.parents) queue.push({ sha: p, depth: depth + 1 });
        }
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.content)) queue.push({ sha: entry.sha, depth });
      } else if (obj.type === 'tag') {
        const target = obj.content.toString('utf8').match(/^object ([0-9a-f]{40})/m);
        if (target) queue.push({ sha: target[1], depth });
      }
    }
    return seen;
  }
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly sha: string;
}

/** Parse a tree object's content into its entries. */
export function parseTree(content: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < content.length) {
    const space = content.indexOf(0x20, at);
    const mode = content.subarray(at, space).toString('utf8');
    const nul = content.indexOf(0x00, space + 1);
    const name = content.subarray(space + 1, nul).toString('utf8');
    const sha = content.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    at = nul + 21;
  }
  return entries;
}

/** Build a tree object's content from entries (git sorts trees itself; caller sorts). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- pkt-line

/** One pkt-line: 4 hex digits of total length + payload; null encodes a flush. */
export function pktLine(payload: Buffer | string | null): Buffer {
  if (payload === null) return Buffer.from('0000', 'ascii');
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/**
 * Split a buffer into pkt-line payloads; flush packets come back as null.
 * Delim (0001) and response-end (0002) packets are separators between
 * sections, not content: they are skipped, so a v2 request's argument
 * section survives intact.
 */
export function splitPktLines(buf: Buffer): (Buffer | null)[] {
  const out: (Buffer | null)[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const len = parseInt(buf.subarray(at, at + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0) {
      out.push(null);
      at += 4;
      continue;
    }
    if (len === 1 || len === 2) {
      at += 4;
      continue;
    }
    if (len < 4 || at + len > buf.length) break;
    out.push(buf.subarray(at + 4, at + len));
    at += len;
  }
  return out;
}

/** Where splitPktLines stopped: the offset just past the last whole packet. */
export function pktLinesEnd(buf: Buffer): number {
  let at = 0;
  while (at + 4 <= buf.length) {
    const len = parseInt(buf.subarray(at, at + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0) {
      at += 4;
      continue;
    }
    if (len < 4 || at + len > buf.length) break;
    at += len;
  }
  return at;
}

// ---------------------------------------------------------------- pack write

/** Serialise a set of objects as a packfile v2 (no deltas), with trailer. */
export function buildPack(store: ObjectStore, shas: Iterable<string>): Buffer {
  const list = [...shas].filter((sha) => store.has(sha));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const sha of list) {
    const obj = store.get(sha)!;
    const size = obj.content.length;
    // varint: type in bits 4-6 of the first byte, size in the low 4 then 7s.
    const bytes: number[] = [];
    let first = (TYPE_NUM[obj.type] << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) b |= 0x80;
      bytes.push(b);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.content));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pack read

function readVarint(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = at;
  for (;;) {
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: pos };
}

/** Apply a git delta to its base content. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const src = readVarint(delta, at);
  at = src.next;
  const dst = readVarint(delta, at);
  at = dst.next;
  if (src.value !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset |= delta[at++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size |= delta[at++] << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op > 0) {
      out.push(delta.subarray(at, at + op));
      written += op;
      at += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dst.value || written !== dst.value) throw new Error('delta size mismatch');
  return result;
}

/** Inflate one zlib stream starting at `at`; resolves with data + bytes consumed. */
function inflateOne(buf: Buffer, at: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: (stream as unknown as { bytesWritten: number }).bytesWritten }));
    stream.on('error', reject);
    stream.end(buf.subarray(at));
  });
}

interface PackEntry {
  readonly offset: number;
  readonly typeNum: number;
  readonly data: Buffer;
  readonly baseSha?: string;
  readonly baseOffset?: number;
}

/**
 * Parse a packfile into the store. Deltas resolve against the pack itself
 * or objects the store already holds (a thin pack). Returns the object ids
 * the pack carried (after delta resolution, the ids it created).
 */
export async function readPack(store: ObjectStore, pack: Buffer): Promise<string[]> {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let at = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  for (let i = 0; i < count; i++) {
    const entryStart = at;
    let b = pack[at++];
    const typeNum = (b >> 4) & 0x07;
    while (b & 0x80) b = pack[at++];
    let baseSha: string | undefined;
    let baseOffset: number | undefined;
    if (typeNum === 6) {
      let c = pack[at++];
      let offset = c & 0x7f;
      while (c & 0x80) {
        c = pack[at++];
        offset = ((offset + 1) << 7) | (c & 0x7f);
      }
      baseOffset = entryStart - offset;
    } else if (typeNum === 7) {
      baseSha = pack.subarray(at, at + 20).toString('hex');
      at += 20;
    }
    const { data, consumed } = await inflateOne(pack, at);
    at += consumed;
    const entry: PackEntry = { offset: entryStart, typeNum, data, baseSha, baseOffset };
    entries.push(entry);
    byOffset.set(entryStart, entry);
  }
  const resolved = new Map<number, string>();
  const resolve = (entry: PackEntry): string => {
    const memo = resolved.get(entry.offset);
    if (memo) return memo;
    let sha: string;
    if (entry.typeNum === 6 || entry.typeNum === 7) {
      let base: StoredObject | undefined;
      if (entry.baseSha) base = store.get(entry.baseSha);
      else if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry) base = store.get(resolve(baseEntry));
      }
      if (!base) throw new Error('pack delta base is missing');
      sha = store.put(base.type, applyDelta(base.content, entry.data));
    } else {
      const type = NUM_TYPE[entry.typeNum];
      if (!type) throw new Error(`pack object type ${entry.typeNum}`);
      sha = store.put(type, entry.data);
    }
    resolved.set(entry.offset, sha);
    return sha;
  };
  return entries.map(resolve);
}

/** Inflate data the store holds compressed nowhere: a sanity helper for tests. */
export function inflateAll(buf: Buffer): Buffer {
  return inflateSync(buf);
}
