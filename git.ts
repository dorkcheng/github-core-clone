// Git smart HTTP: v2 upload-pack (ls-refs, fetch) and v0 receive-pack (push), over the
// forge's own object store. The wire format follows the kit's git-client exactly: v2
// capability advertisement, pkt-line sections separated by delim/flush, sideband-64k
// packfile sections, and a report-status-v2 push report wrapped in band 1.

import {
  ZERO_OID, decodePktLines, encodePktLine, encodePktLines, fetchPlan, hashObject, isObjectId,
  parseCommit, parseTag, readPack, writePack,
} from './gitcore.ts';
import type { GitObject, GitObjectType } from './gitcore.ts';
import type { Repo, Store } from './store.ts';

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

export function jsonResponse(status: number, value: unknown): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

const AGENT = 'forge/1.0';
const UPLOAD_PACK_CAPS = ['ls-refs=unborn', 'fetch=shallow', 'object-format=sha1', `agent=${AGENT}`];
const RECEIVE_PACK_CAPS =
  'report-status report-status-v2 delete-refs side-band-64k ofs-delta thin-pack agent=forge/1.0 symref=HEAD:refs/heads/main';

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Follow annotated tags to the commit they point at. */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

function isAnnotatedTag(repo: Repo, oid: string): boolean {
  const object = repo.objects.get(oid);
  return object?.type === 'tag';
}

function refLines(repo: Repo, options: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): string[] {
  const lines: string[] = [];
  const defaultBranch = repo.defaultBranch;
  const headOid = repo.refs.get(`refs/heads/${defaultBranch}`);
  const matches = (name: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  const headMatches = matches('HEAD');
  if (headOid === undefined) {
    if (options.unborn && headMatches) {
      lines.push(`unborn HEAD${options.symrefs ? ` symref-target:refs/heads/${defaultBranch}` : ''}`);
    }
    return lines;
  }
  if (headMatches) {
    lines.push(`${headOid} HEAD${options.symrefs ? ` symref-target:refs/heads/${defaultBranch}` : ''}`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (options.peel && isAnnotatedTag(repo, ref.oid)) line += ` peeled:${peelToCommit(repo, ref.oid)}`;
    lines.push(line);
  }
  return lines;
}

export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string): HttpResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return jsonResponse(404, { message: 'Not Found' });
  if (service === 'git-upload-pack') {
    const body = encodePktLines([
      '# service=git-upload-pack\n',
      'flush',
      'version 2\n',
      ...UPLOAD_PACK_CAPS.map((capability) => `${capability}\n`),
      'flush',
    ]);
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
      body,
    };
  }
  if (service === 'git-receive-pack') {
    const defaultBranch = repo.defaultBranch;
    const headOid = repo.refs.get(`refs/heads/${defaultBranch}`);
    const parts: Array<string | 'flush'> = ['# service=git-receive-pack\n', 'flush'];
    if (headOid === undefined) {
      parts.push(`${ZERO_OID} capabilities^{}\u0000${RECEIVE_PACK_CAPS}\n`);
    } else {
      parts.push(`${headOid} HEAD\u0000${RECEIVE_PACK_CAPS}\n`);
      for (const ref of sortedRefs(repo)) {
        parts.push(`${ref.oid} ${ref.name}\n`);
        if (isAnnotatedTag(repo, ref.oid)) {
          parts.push(`${peelToCommit(repo, ref.oid)} ${ref.name}^{}\n`);
        }
      }
    }
    parts.push('flush');
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-receive-pack-advertisement' },
      body: encodePktLines(parts),
    };
  }
  return jsonResponse(400, { message: `unknown service ${service}` });
}

interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseUploadPackRequest(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const commandLine = packets.find((packet) => packet.kind === 'data');
  if (!commandLine || commandLine.kind !== 'data') throw new Error('upload-pack request has no command line');
  const command = commandLine.payload.toString('utf8').replace(/\n$/, '');
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind === 'data' && seenDelim) {
      args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  return { command, args };
}

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer): HttpResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return jsonResponse(404, { message: 'Not Found' });
  let parsed: { command: string; args: string[] };
  try {
    parsed = parseUploadPackRequest(body);
  } catch (error) {
    return jsonResponse(400, { message: `malformed upload-pack request: ${(error as Error).message}` });
  }
  const { command, args } = parsed;

  if (command === 'command=ls-refs') {
    const options: LsRefsOptions = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const arg of args) {
      if (arg === 'peel') options.peel = true;
      else if (arg === 'symrefs') options.symrefs = true;
      else if (arg === 'unborn') options.unborn = true;
      else if (arg.startsWith('ref-prefix ')) options.prefixes.push(arg.slice('ref-prefix '.length));
    }
    const lines = refLines(repo, options).map((line) => `${line}\n`);
    const responseBody = encodePktLines([...lines, 'flush']);
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
      body: responseBody,
    };
  }

  if (command === 'command=fetch') {
    const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined };
    for (const arg of args) {
      if (arg.startsWith('want ')) request.wants.push(arg.slice(5));
      else if (arg.startsWith('have ')) request.haves.push(arg.slice(5));
      else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8));
      else if (arg.startsWith('deepen ')) {
        const depth = Number.parseInt(arg.slice(7), 10);
        if (Number.isInteger(depth) && depth > 0) request.depth = depth;
      }
    }
    for (const want of request.wants) {
      if (!isObjectId(want) || !repo.objects.has(want)) {
        return jsonResponse(400, { message: `fetch wants unknown object ${want}` });
      }
    }
    let plan: ReturnType<typeof fetchPlan>;
    try {
      plan = fetchPlan(request.wants, store.lookup(repo), {
        haves: request.haves,
        shallow: request.shallow,
        depth: request.depth,
      });
    } catch (error) {
      return jsonResponse(400, { message: `fetch failed: ${(error as Error).message}` });
    }
    const parts: Array<string | Buffer | 'delim' | 'flush'> = [];
    // The acknowledgments section only exists when the client sent 'have' lines to
    // negotiate against; a client with no haves expects the packfile section first.
    if (request.haves.length > 0) {
      parts.push('acknowledgments\n');
      const acked = request.haves.filter((have) => repo.objects.has(have));
      if (acked.length > 0) {
        for (const have of acked) parts.push(`ACK ${have}\n`);
        parts.push('ready\n');
      } else {
        parts.push('NAK\n');
      }
      parts.push('delim');
    }
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push('shallow-info\n');
      for (const oid of plan.shallow) parts.push(`shallow ${oid}\n`);
      for (const oid of plan.unshallow) parts.push(`unshallow ${oid}\n`);
      parts.push('delim');
    }
    if (plan.objects.size > 0) {
      const objects: GitObject[] = [...plan.objects]
        .sort()
        .map((oid) => repo.objects.get(oid) as GitObject);
      const pack = writePack(objects);
      parts.push('packfile\n');
      // Sideband-64k: band 1 carries the pack, split into at most 65515-byte chunks.
      // Each chunk is one pkt-line payload (band byte + up to 65515 pack bytes); the
      // framing is added once, by encodePktLines below.
      const chunkSize = 65515;
      for (let offset = 0; offset < pack.length; offset += chunkSize) {
        const chunk = pack.subarray(offset, Math.min(offset + chunkSize, pack.length));
        parts.push(Buffer.concat([Buffer.from([1]), chunk]));
      }
      parts.push('flush');
    } else {
      parts.push('flush');
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
      body: encodePktLines(parts),
    };
  }

  return jsonResponse(400, { message: `unknown upload-pack command ${JSON.stringify(command)}` });
}

/** Split a receive-pack body into its command pkt-lines and the pack that follows the flush. */
function splitReceivePack(body: Buffer): { commands: string[]; caps: string; pack: Buffer } {
  const commands: string[] = [];
  let caps = '';
  let offset = 0;
  let first = true;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('receive-pack body ends before its flush');
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || length > 65520 || offset + length > body.length) {
      throw new Error(`invalid pkt-line length ${length}`);
    }
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    if (first) {
      const nul = payload.indexOf('\u0000');
      if (nul >= 0) {
        caps = payload.slice(nul + 1).replace(/\n$/, '');
        commands.push(payload.slice(0, nul).replace(/\n$/, ''));
      } else {
        commands.push(payload.replace(/\n$/, ''));
      }
      first = false;
    } else {
      commands.push(payload.replace(/\n$/, ''));
    }
    offset += length;
  }
  return { commands, caps, pack: body.subarray(offset) };
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): HttpResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return jsonResponse(404, { message: 'Not Found' });
  let split: { commands: string[]; caps: string; pack: Buffer };
  try {
    split = splitReceivePack(body);
  } catch (error) {
    return jsonResponse(400, { message: `malformed receive-pack request: ${(error as Error).message}` });
  }
  const { commands, caps, pack } = split;

  // Unpack first: even a fully rejected push leaves its objects in the store.
  if (pack.length > 0) {
    let read: ReturnType<typeof readPack>;
    try {
      read = readPack(pack, { resolveBase: store.lookup(repo) });
    } catch (error) {
      return jsonResponse(400, { message: `malformed pack: ${(error as Error).message}` });
    }
    store.addPackObjects(repo, read.objects.values());
  }

  const useSideband = caps.split(' ').includes('side-band-64k');
  const reportLines: string[] = ['unpack ok\n'];
  for (const command of commands) {
    const parts = command.split(' ');
    if (parts.length !== 3) {
      reportLines.push(`ng ${parts[2] ?? ''} malformed command\n`);
      continue;
    }
    const [oldOid, newOid, refName] = parts as [string, string, string];
    const current = repo.refs.get(refName);
    if (!isObjectId(oldOid) || !isObjectId(newOid)) {
      reportLines.push(`ng ${refName} bad object id\n`);
      continue;
    }
    if (oldOid !== ZERO_OID && current === undefined) {
      reportLines.push(`ng ${refName} old value does not match\n`);
      continue;
    }
    if (oldOid !== ZERO_OID && current !== oldOid) {
      reportLines.push(`ng ${refName} old value does not match\n`);
      continue;
    }
    if (oldOid === ZERO_OID && current !== undefined) {
      reportLines.push(`ng ${refName} already exists\n`);
      continue;
    }
    if (newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${refName} ref does not exist\n`);
        continue;
      }
      repo.refs.delete(refName);
      reportLines.push(`ok ${refName}\n`);
      continue;
    }
    const newObject = repo.objects.get(newOid);
    if (!newObject) {
      reportLines.push(`ng ${refName} object does not exist\n`);
      continue;
    }
    if (current !== undefined && current !== newOid) {
      // Update: the new tip must descend from the current tip.
      const ancestors = new Set<string>();
      const queue = [newOid];
      while (queue.length) {
        const oid = queue.pop() as string;
        if (ancestors.has(oid)) continue;
        ancestors.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
      if (!ancestors.has(current)) {
        reportLines.push(`ng ${refName} non-fast-forward\n`);
        continue;
      }
    }
    repo.refs.set(refName, newOid);
    reportLines.push(`ok ${refName}\n`);
  }

  const report = encodePktLines([...reportLines, 'flush']);
  let responseBody: Buffer;
  if (useSideband) {
    const parts: Buffer[] = [];
    const chunkSize = 65515;
    for (let offset = 0; offset < report.length; offset += chunkSize) {
      const chunk = report.subarray(offset, Math.min(offset + chunkSize, report.length));
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(Buffer.from('0000', 'ascii'));
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = report;
  }
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
    body: responseBody,
  };
}
