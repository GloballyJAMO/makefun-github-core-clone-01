// Git smart HTTP: info/refs advertisements (protocol v0 and v2),
// ls-refs, fetch (v2 sections and the v0 want/have exchange) and
// receive-pack pushes with report-status. Objects move as whole-object
// packs (no deltas out; deltas in are resolved by gitstore.readPack).

import { buildPack, pktLine, pktLinesEnd, readPack, splitPktLines } from './gitstore.ts';
import type { ObjectStore } from './gitstore.ts';
import { ForgeError, ancestors, isAncestor } from './forge.ts';
import type { Repo } from './forge.ts';

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const ZERO = '0'.repeat(40);
const UPLOAD_CAPS_V2 = ['version 2', 'agent=makefun-forge/1.0', 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];
const UPLOAD_CAPS_V0 = 'side-band-64k ofs-delta shallow agent=makefun-forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status delete-refs side-band-64k ofs-delta agent=makefun-forge/1.0';

function text(result: string, status = 200, contentType = 'text/plain; charset=utf-8'): GitResult {
  return { status, contentType, body: Buffer.from(result, 'utf8') };
}

/** Every ref the repo advertises, HEAD first, the rest in name order. */
function advertisedRefs(repo: Repo): { name: string; oid: string }[] {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
  const headTip = repo.refs.get(repo.headTarget());
  return [{ name: 'HEAD', oid: headTip ?? ZERO }, ...refs];
}

/** Peel a ref target to a commit (through annotated tags), or null. */
function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth++) {
    const obj = store.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})/m.exec(obj.content.toString('utf8'));
    if (!match) return null;
    current = match[1];
  }
  return null;
}

export function infoRefs(repo: Repo, service: string, protocolV2: boolean): GitResult {
  const contentType = `application/x-${service}-advertisement`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktLine(null)];
  if (service === 'git-upload-pack' && protocolV2) {
    for (const line of UPLOAD_CAPS_V2) parts.push(pktLine(`${line}\n`));
    parts.push(pktLine(null));
    return { status: 200, contentType, body: Buffer.concat(parts) };
  }
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS_V0 : `${UPLOAD_CAPS_V0} symref=HEAD:${repo.headTarget()}`;
  const refs = advertisedRefs(repo);
  if (refs.length === 1 && refs[0].oid === ZERO) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      const peeled = peelToCommit(repo.store, ref.oid);
      if (peeled !== null && peeled !== ref.oid && ref.name.startsWith('refs/tags/')) {
        parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    });
  }
  parts.push(pktLine(null));
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefs(repo: Repo, args: LsRefsArgs): GitResult {
  const lines: string[] = [];
  const headTarget = repo.headTarget();
  const headTip = repo.refs.get(headTarget);
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      lines.push(`${headTip} HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}`);
    }
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of refs) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peelToCommit(repo.store, oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const parts = lines.map((line) => pktLine(`${line}\n`));
  parts.push(pktLine(null));
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
  noProgress: boolean;
}

interface FetchPlan {
  pack: Buffer;
  objectCount: number;
  shallowLines: string[];
  unshallowLines: string[];
  commonHaves: string[];
}

/**
 * Work out what a fetch sends. The client's held set is the closure of its
 * haves, cut at the shallow boundary it declares; the delivered set is the
 * closure of the wants, cut at `deepen` generations when one is given.
 */
function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const store = repo.store;
  const held = new Set<string>();
  if (args.haves.length > 0) {
    const boundary = new Set(args.shallow);
    const heldCommits = new Set<string>();
    const queue = [...args.haves];
    while (queue.length > 0) {
      const sha = queue.shift()!;
      if (heldCommits.has(sha)) continue;
      const parsed = store.parseCommit(sha);
      if (!parsed) continue;
      heldCommits.add(sha);
      if (!boundary.has(sha)) queue.push(...parsed.parents);
    }
    // The held objects are those commits plus their trees and blobs:
    // ancestors past the shallow boundary are exactly what is NOT held.
    for (const sha of heldCommits) {
      const parsed = store.parseCommit(sha);
      if (!parsed) continue;
      held.add(sha);
      for (const oid of store.closureFrom([parsed.tree])) held.add(oid);
    }
  }
  const depth = args.deepen === null ? Infinity : Math.max(0, args.deepen - 1);
  const delivered = store.closureFrom(args.wants.filter((oid) => store.has(oid)), depth);
  const packObjects = [...delivered].filter((oid) => !held.has(oid));

  // The new shallow boundary: delivered commits whose parents were cut.
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  if (args.deepen !== null) {
    const deliveredCommits = [...delivered].filter((oid) => store.get(oid)?.type === 'commit');
    for (const sha of deliveredCommits) {
      const parsed = store.parseCommit(sha);
      if (parsed && parsed.parents.some((parent) => !delivered.has(parent))) shallowLines.push(sha);
    }
    for (const old of args.shallow) {
      const parsed = store.parseCommit(old);
      if (parsed && parsed.parents.length > 0 && parsed.parents.every((parent) => delivered.has(parent))) unshallowLines.push(old);
    }
  }
  const commonHaves = args.haves.filter((oid) => store.get(oid)?.type === 'commit');
  return { pack: buildPack(store, packObjects), objectCount: packObjects.length, shallowLines, unshallowLines, commonHaves };
}

/** Frame pack bytes as sideband-64k packets (band 1), with an optional progress note on band 2. */
function sidebandPackets(pack: Buffer, progress: string | null): Buffer[] {
  const parts: Buffer[] = [];
  if (progress !== null) {
    const note = Buffer.concat([Buffer.from([2]), Buffer.from(progress, 'utf8')]);
    parts.push(pktLine(note));
  }
  const CHUNK = 32768;
  for (let at = 0; at < pack.length; at += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(at, at + CHUNK)])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return parts;
}

const DELIM = Buffer.from('0001', 'ascii');

function fetchV2(repo: Repo, args: FetchArgs): GitResult {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.commonHaves.length > 0) {
    for (const oid of plan.commonHaves) parts.push(pktLine(`ACK ${oid}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  if (!args.done) parts.push(pktLine('ready\n'));
  parts.push(DELIM);
  if (plan.shallowLines.length > 0 || plan.unshallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  if (args.done && plan.objectCount > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(plan.pack, args.noProgress ? null : 'Counting objects done\n'));
    parts.push(DELIM);
  } else if (args.done) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(plan.pack, null));
    parts.push(DELIM);
  }
  parts.push(pktLine(null));
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchV0(repo: Repo, args: FetchArgs): GitResult {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.commonHaves.length > 0) parts.push(pktLine(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(plan.pack, args.noProgress ? null : 'Counting objects done\n'));
  parts.push(pktLine(null));
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function uploadPack(repo: Repo, body: Buffer): GitResult {
  const packets = splitPktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet === null) break;
    lines.push(packet.toString('utf8').replace(/\n$/, ''));
  }
  const first = lines[0] ?? '';
  if (first.startsWith('command=ls-refs')) {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of lines.slice(1)) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    return lsRefs(repo, args);
  }
  if (first.startsWith('command=fetch')) {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false, noProgress: false };
    for (const line of lines.slice(1)) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
      else if (line === 'done') args.done = true;
      else if (line === 'no-progress') args.noProgress = true;
    }
    return fetchV2(repo, args);
  }
  if (first.startsWith('want ') || lines.some((line) => line.startsWith('want '))) {
    // Protocol v0: wants (the first carries capabilities), a flush, then
    // haves and done. splitPktLines dropped the flush positions, so wants
    // and haves are told apart by the raw packet walk instead.
    const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: true, noProgress: false };
    let section = 0;
    for (const packet of splitPktLines(body)) {
      if (packet === null) {
        section += 1;
        continue;
      }
      const line = packet.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0]);
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
      else if (line === 'done') args.done = true;
      void section;
    }
    return fetchV0(repo, args);
  }
  return text('unsupported upload-pack request', 400);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function receivePack(repo: Repo, body: Buffer): Promise<GitResult> {
  const headerEnd = pktLinesEnd(body);
  const packets = splitPktLines(body.subarray(0, headerEnd));
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  for (const packet of packets) {
    if (packet === null) break;
    let line = packet.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = new Set(line.slice(nul + 1).split(' ').filter(Boolean).map((cap) => cap.split('=')[0]));
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  const pack = body.subarray(headerEnd);
  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      await readPack(repo.store, pack);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'index-pack failed';
    }
  }

  const reports: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const fail = (reason: string): void => void reports.push({ ref: command.ref, ok: false, reason });
    if (unpackError !== null) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO) {
      // A delete.
      if (current === undefined) fail('reference does not exist');
      else if (command.ref === repo.headTarget()) fail('deletion of the current branch prohibited');
      else if (current !== command.oldOid) fail('stale info');
      else {
        repo.refs.delete(command.ref);
        reports.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.store.has(command.newOid)) {
      fail('missing object');
      continue;
    }
    if (command.oldOid === ZERO) {
      if (current !== undefined) {
        fail('already exists');
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== command.oldOid) {
      fail('stale info');
      continue;
    }
    if (command.oldOid !== command.newOid && !isAncestor(repo.store, command.oldOid, command.newOid)) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reports.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (!capabilities.has('report-status')) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const reportLines: Buffer[] = [pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError.replace(/\n/g, ' ')}\n`)];
  for (const report of reports) {
    reportLines.push(pktLine(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`));
  }
  reportLines.push(pktLine(null));
  const reportStream = Buffer.concat(reportLines);
  if (capabilities.has('side-band-64k')) {
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let at = 0; at < reportStream.length; at += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), reportStream.subarray(at, at + CHUNK)])));
    }
    parts.push(pktLine(null));
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: reportStream };
}

export function gitError(status: number, message: string): GitResult {
  return text(message, status);
}

export { ForgeError };
