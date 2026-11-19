// github-core-clone-01 — a GitHub-compatible forge (Git smart HTTP + REST v3
// + GraphQL v4 + MCP), written from the kit's conformance spec alone.
//
// Entrypoint: main.ts (node /bot/main.ts). This module holds the whole
// forge: the in-memory store, the git object model and pack protocol, the
// REST surface, the GraphQL executor and the MCP endpoint. No dependencies,
// Node stdlib only. No wall clock and no unseeded randomness anywhere in
// stored or sent data: timestamps come from a fixed base plus a monotonic
// counter, so two runs fed the same requests behave identically.
//
// Layout of this file:
//   1. constants and small utilities
//   2. git object model (hashing, commits, trees, tags)
//   3. packfiles (read incl. OFS/REF deltas, write plain objects)
//   4. pkt-lines and sideband framing
//   5. the store (repos, refs, issues, pulls, labels, comments)
//   6. tree/commit helpers (lookup, path updates, history walks, diffs)
//   7. HTTP server core (routing, auth, body reading, responses)
//   8. REST v3 handlers
//   9. git smart HTTP handlers
//   10. GraphQL parser and executor
//   11. MCP handlers and the exported createForgeServer()

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- 1. constants

/** The viewer the token names (kit wire.ts buildScenario().viewer). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** The org the scenario names (repos under it never exist here). */
export const ORG_LOGIN = 'faint-meadow-org';
/** The forge's own agent string, advertised on the git wire. */
export const FORGE_AGENT = 'github-core-clone-forge/3.0.0';
export const FORGE_VERSION = '3.0.0';
/** The fixed epoch every timestamp derives from: 2025-01-01T00:00:00Z. */
export const EPOCH_SEC = 1735689600;
/** The all-zero object id. */
export const ZERO_OID = '0000000000000000000000000000000000000000';
/** The default branch. */
export const DEFAULT_BRANCH = 'main';
/** Largest data payload one sideband packet carries (65520 - 4 - 1). */
export const SIDEBAND_MAX_DATA = 65515;

/** Whether a string is a 40-hex object id. */
export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** A fixed-base ISO timestamp: base + `counter` seconds, deterministic. */
export function tsIso(counter: number): string {
  return new Date((EPOCH_SEC + counter) * 1000).toISOString();
}

/** Base64url without padding (opaque global ids, cursors). */
export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode a base64url string, or null when it is not one. */
export function b64urlDecode(value: string): string | null {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** SHA-1 of a buffer, hex. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ---------------------------------------------------------------- 2. git objects

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** The object id of `type` + `data`: SHA-1 over `<type> <size>\0` + data. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** One tree entry, as parsed and as built. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/**
 * Git's tree sort: entries compare by name bytes, except a directory
 * compares as if its name ended in `/`.
 */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const aName = a.mode === '40000' ? `${a.name}/` : a.name;
  const bName = b.mode === '40000' ? `${b.name}/` : b.name;
  const aBuf = Buffer.from(aName, 'utf8');
  const bBuf = Buffer.from(bName, 'utf8');
  return Buffer.compare(aBuf, bBuf);
}

/** Serialise tree entries into git's on-disk tree bytes. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse git tree bytes into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no space after mode');
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('malformed tree: no NUL after name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('malformed tree: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** A parsed commit: its tree, parents, message and identity lines. */
export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse commit bytes. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
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

/** The identity line the forge stamps on commits it creates itself. */
export function forgeIdentity(timestampSec: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${timestampSec} +0000`;
}

export interface CommitInput {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
}

/** Serialise a commit. The message is used verbatim (it ends with \n). */
export function buildCommit(input: CommitInput): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

export interface TagInput {
  object: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Serialise an annotated tag object. */
export function buildTag(input: TagInput): Buffer {
  return Buffer.from(
    `object ${input.object}\ntype commit\ntag ${input.tag}\ntagger ${input.tagger}\n\n${input.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------- 3. packfiles

/** One object to write into a pack. */
export interface PackObjectInput {
  type: GitObjectType;
  data: Buffer;
}

const PACK_TYPE_CODES: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const PACK_CODE_TYPES: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

/** The varint type/size header one pack object carries. */
export function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = PACK_TYPE_CODES[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (remaining & 0x0f) | (code << 4);
  remaining >>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Build a packfile (version 2, plain objects, no deltas) from objects,
 * with the SHA-1 trailer over all preceding bytes.
 */
export function writePack(objects: readonly PackObjectInput[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a pack's trailer; `{ok, expected, actual}`. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 20) return { ok: false, expected: '', actual: '' };
  const body = pack.subarray(0, pack.length - 20);
  const expected = createHash('sha1').update(body).digest('hex');
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}

interface RawPackEntry {
  type: number;
  /** The inflated bytes for plain objects; null for deltas. */
  data: Buffer | null;
  /** OFS_DELTA: distance back to the base entry's start offset. */
  ofsBase: number | null;
  /** REF_DELTA: the base object's id. */
  refBase: string | null;
  /** The raw (still delta-encoded) bytes for a delta entry. */
  delta: Buffer | null;
  /** Byte offset of this entry's header inside the pack. */
  offset: number;
}

/**
 * Apply a git delta: first the source-size varint, then the target-size
 * varint, then copy/insert instructions. Copy opcodes have their high
 * bit set; the low 4 bits name the offset bytes present and the next 3
 * the size bytes present. Insert opcodes (high bit clear) name a literal
 * run of that many bytes.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('malformed delta: truncated varint');
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('malformed delta: source size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (pos >= delta.length) throw new Error('malformed delta: truncated copy offset');
          offset |= delta[pos]! << (bit * 8);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          if (pos >= delta.length) throw new Error('malformed delta: truncated copy size');
          size |= delta[pos]! << (bit * 8);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('malformed delta: copy past the base end');
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('malformed delta: truncated insert');
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('malformed delta: zero opcode');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) {
    throw new Error('malformed delta: target size mismatch');
  }
  return result;
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a packfile (version 2), resolving OFS_DELTA and REF_DELTA entries.
 * `resolveBase` answers objects already in the repository (REF_DELTA
 * bases that are not in this pack). Returns every object keyed by its id.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): ReadPackResult {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const entries: RawPackEntry[] = [];
  let pos = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = pos;
    if (pos >= pack.length - 20) throw new Error('pack truncated at object header');
    let byte = pack[pos]!;
    pos += 1;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (pos >= pack.length - 20) throw new Error('pack truncated in size varint');
      byte = pack[pos]!;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let ofsBase: number | null = null;
    let refBase: string | null = null;
    if (type === 6) {
      if (pos >= pack.length - 20) throw new Error('pack truncated in OFS_DELTA offset');
      byte = pack[pos]!;
      pos += 1;
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (pos >= pack.length - 20) throw new Error('pack truncated in OFS_DELTA offset');
        byte = pack[pos]!;
        pos += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      ofsBase = entryOffset - offset;
    } else if (type === 7) {
      if (pos + 20 > pack.length - 20) throw new Error('pack truncated in REF_DELTA base');
      refBase = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    // The deflated stream ends where the next object (or the trailer)
    // begins; inflate incrementally by growing the window until the
    // result has the declared size.
    const dataStart = pos;
    const inflated = inflatePackObject(pack, dataStart, size);
    pos = dataStart + inflated.consumed;
    if (type === 6 || type === 7) {
      entries.push({ type, data: null, ofsBase, refBase, delta: inflated.data, offset: entryOffset });
    } else {
      const objectType = PACK_CODE_TYPES[type];
      if (objectType === undefined) throw new Error(`unknown pack object type ${type}`);
      entries.push({ type, data: inflated.data, ofsBase: null, refBase: null, delta: null, offset: entryOffset });
    }
  }
  const byOffset = new Map<number, RawPackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolved = new Map<string, GitObject>();
  let deltaCount = 0;
  const resolveEntry = (entry: RawPackEntry, seen: Set<number>): GitObject => {
    if (seen.has(entry.offset)) throw new Error('delta cycle in pack');
    seen.add(entry.offset);
    if (entry.data !== null) {
      const type = PACK_CODE_TYPES[entry.type]!;
      return { type, data: entry.data };
    }
    deltaCount += 1;
    let base: GitObject | undefined;
    if (entry.ofsBase !== null) {
      const baseEntry = byOffset.get(entry.ofsBase);
      if (baseEntry === undefined) throw new Error('OFS_DELTA base not in pack');
      base = resolveEntry(baseEntry, seen);
    } else if (entry.refBase !== null) {
      for (const [oid, object] of resolved) {
        if (oid === entry.refBase) {
          base = object;
          break;
        }
      }
      if (base === undefined && resolveBase !== undefined) base = resolveBase(entry.refBase);
      if (base === undefined) throw new Error(`REF_DELTA base ${entry.refBase} not found`);
    } else {
      throw new Error('delta entry without a base');
    }
    const data = applyDelta(base.data, entry.delta!);
    return { type: base.type, data };
  };
  for (const entry of entries) {
    const object = resolveEntry(entry, new Set<number>());
    resolved.set(hashObject(object.type, object.data), object);
  }
  return { objects: resolved, deltaCount };
}

/**
 * Inflate one pack object's deflated bytes starting at `start`, stopping
 * as soon as `size` bytes are produced; returns the bytes and how many
 * input bytes were consumed. One call: `inflateSync` with `info: true`
 * reports the input bytes the stream consumed in `engine.bytesWritten`,
 * so no search for the stream end is needed.
 */
function inflatePackObject(pack: Buffer, start: number, size: number): { data: Buffer; consumed: number } {
  const view = pack.subarray(start, pack.length - 20);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch {
    throw new Error('pack object inflate failed');
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0 || result.buffer.length !== size) {
    throw new Error('pack object inflate failed');
  }
  return { data: result.buffer, consumed };
}

// ---------------------------------------------------------------- 4. pkt-lines

/** One parsed pkt-line. */
export interface PktLine {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Encode one pkt-line: 4 hex digits of total length, then the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet, `0000`. */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet, `0001`. */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/**
 * Parse a buffer of pkt-lines. Throws on a malformed length or a
 * truncated line. The returned lines never include a trailing flush
 * packet's payload.
 */
export function parsePktLines(buffer: Buffer): { lines: PktLine[]; rest: Buffer } {
  const lines: PktLine[] = [];
  let pos = 0;
  while (pos + 4 <= buffer.length) {
    const lengthText = buffer.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(lengthText)}`);
    }
    const length = parseInt(lengthText, 16);
    if (length === 0) {
      lines.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      return { lines, rest: buffer.subarray(pos) };
    }
    if (length === 1) {
      lines.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 2) {
      lines.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buffer.length) {
      throw new Error('malformed pkt-line: length past the buffer end');
    }
    lines.push({ kind: 'data', payload: buffer.subarray(pos + 4, pos + length) });
    pos += length;
  }
  if (pos !== buffer.length) throw new Error('malformed pkt-line: trailing bytes');
  return { lines, rest: Buffer.alloc(0) };
}

/** The data payloads of parsed pkt-lines, as UTF-8 strings (no trailing \n). */
export function pktLineTexts(lines: readonly PktLine[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    out.push(line.payload.toString('utf8').replace(/\n$/, ''));
  }
  return out;
}

/** One sideband packet: a pkt-line whose payload is band byte + data. */
export function sidebandPacket(band: 1 | 2 | 3, data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return pktLine(Buffer.concat([Buffer.from([band]), body]));
}

/**
 * Split `data` into sideband packets of at most SIDEBAND_MAX_DATA bytes
 * on the given band, each its own pkt-line.
 */
export function sidebandPackets(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_MAX_DATA) {
    packets.push(sidebandPacket(band, data.subarray(offset, offset + SIDEBAND_MAX_DATA)));
  }
  return packets;
}

// ---------------------------------------------------------------- 5. the store

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: Label[];
  user: string;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
  /** Memoised GET-issue JSON; cleared on any change to the issue. */
  jsonCache: Buffer | null;
}

export interface PullRef {
  ref: string;
  sha: string;
  label: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: PullRef;
  base: PullRef;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextIssueNumber: number;
  nextPullNumber: number;
  /** Bumped on any git mutation; invalidates the git caches below. */
  version: number;
  advCache: Map<string, Buffer>;
  lsRefsCache: Buffer | null;
  lsRefsVersion: number;
  fetchPackCache: Map<string, Buffer>;
  /** Parsed parent lists of commit objects, filled on first use. */
  commitParentsCache: Map<string, string[]>;
}

/** The forge's whole state, plus the deterministic counters. */
export class Forge {
  /** The bearer token the suite presents ('' = accept any non-empty one). */
  token: string;
  repos: Map<string, Repo>;
  nextRepoId: number;
  nextIssueId: number;
  nextCommentId: number;
  nextPullId: number;
  /** Monotonic counter behind every timestamp the forge emits. */
  tsCounter: number;
  /** Monotonic counter behind every X-GitHub-Request-Id. */
  requestCounter: number;

  constructor(token: string) {
    this.token = token;
    this.repos = new Map<string, Repo>();
    this.nextRepoId = 1;
    this.nextIssueId = 1;
    this.nextCommentId = 1;
    this.nextPullId = 1;
    this.tsCounter = 0;
    this.requestCounter = 0;
  }

  /** The next deterministic timestamp (seconds since the fixed epoch). */
  nextTs(): number {
    this.tsCounter += 1;
    return EPOCH_SEC + this.tsCounter;
  }

  /** The next deterministic timestamp as an ISO string. */
  nextTsIso(): string {
    this.tsCounter += 1;
    return tsIso(this.tsCounter);
  }

  /** The next request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${process.pid}-${this.requestCounter.toString(16)}`;
  }

  /** Whether the presented Authorization header is the suite's token. */
  checkAuth(req: IncomingMessage): boolean {
    if (this.token === '') {
      const header = req.headers.authorization;
      return typeof header === 'string' && header.startsWith('Bearer ') && header.length > 7;
    }
    return req.headers.authorization === `Bearer ${this.token}`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.repoKey(VIEWER_LOGIN, name))) return null;
    const now = this.nextTsIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      private: isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      labels: new Map<string, Label>(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      version: 0,
      advCache: new Map<string, Buffer>(),
      lsRefsCache: null,
      lsRefsVersion: -1,
      fetchPackCache: new Map<string, Buffer>(),
      commitParentsCache: new Map<string, string[]>(),
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** Store an object when absent; answer its id. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Set a ref and invalidate every git cache that depends on the refs. */
  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.version += 1;
    repo.advCache.clear();
    repo.lsRefsCache = null;
    repo.fetchPackCache.clear();
  }

  /** Delete a ref and invalidate the git caches. */
  deleteRef(repo: Repo, ref: string): boolean {
    const existed = repo.refs.delete(ref);
    if (existed) {
      repo.version += 1;
      repo.advCache.clear();
      repo.lsRefsCache = null;
      repo.fetchPackCache.clear();
    }
    return existed;
  }

  /**
   * Create a commit on `branch` from `treeOid` with `parents`, stamp it
   * with the forge identity and a deterministic timestamp, store it and
   * move the branch. Answers the commit id.
   */
  createCommitOnBranch(repo: Repo, branch: string, message: string, treeOid: string, parents: readonly string[]): string {
    const ts = this.nextTs();
    const identity = forgeIdentity(ts);
    const commit = buildCommit({ tree: treeOid, parents, message, author: identity, committer: identity });
    const oid = this.putObject(repo, 'commit', commit);
    this.setRef(repo, `refs/heads/${branch}`, oid);
    return oid;
  }
}

// ---------------------------------------------------------------- 6. tree/commit helpers

/** The entries of a tree object, or [] when the tree is absent. */
export function treeEntriesOf(repo: Repo, treeOid: string): TreeEntry[] {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data);
}

/** The tree a commit points at, or null. */
export function commitTreeOid(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** The parents of a commit, or [] when it is absent. */
export function commitParents(repo: Repo, commitOid: string): string[] {
  const cached = repo.commitParentsCache.get(commitOid);
  if (cached !== undefined) return cached;
  const object = repo.objects.get(commitOid);
  const parents = object === undefined || object.type !== 'commit' ? [] : parseCommit(object.data).parents;
  repo.commitParentsCache.set(commitOid, parents);
  return parents;
}

/** The author timestamp of a commit (seconds), or 0 when unreadable. */
export function commitTimestamp(repo: Repo, commitOid: string): number {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return 0;
  const author = parseCommit(object.data).author;
  const match = / (\d+) \+0000$/.exec(author);
  return match !== null ? Number(match[1]) : 0;
}

/** The message of a commit, or ''. */
export function commitMessage(repo: Repo, commitOid: string): string {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return '';
  return parseCommit(object.data).message;
}

/**
 * Flatten a tree into path → {mode, oid}, walking subtrees depth-first.
 * Paths use `/` separators, no leading slash.
 */
export function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, TreeEntry>): void {
  for (const entry of treeEntriesOf(repo, treeOid)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, entry);
  }
}

/** The blob at `segments` under the tree, or null (missing or a dir). */
export function blobAtPath(repo: Repo, treeOid: string, segments: readonly string[]): { oid: string; data: Buffer } | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const entry = treeEntriesOf(repo, current).find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    if (index === segments.length - 1) {
      if (entry.mode === '40000') return null;
      const object = repo.objects.get(entry.oid);
      if (object === undefined || object.type !== 'blob') return null;
      return { oid: entry.oid, data: object.data };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The tree (or null) at `segments` under the tree. */
export function treeAtPath(repo: Repo, treeOid: string, segments: readonly string[]): string | null {
  let current = treeOid;
  for (const segment of segments) {
    const entry = treeEntriesOf(repo, current).find((candidate) => candidate.name === segment);
    if (entry === undefined || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current;
}

/**
 * A new tree equal to `treeOid` with `segments` set to `blobOid` (or
 * removed when null), creating intermediate trees as needed. Stores every
 * new tree object. Answers the new root tree id.
 */
export function setPathInTree(
  forge: Forge,
  repo: Repo,
  treeOid: string,
  segments: readonly string[],
  blobOid: string | null,
): string {
  const head = segments[0]!;
  const rest = segments.slice(1);
  const entries = treeEntriesOf(repo, treeOid);
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const emptyTree = forge.putObject(repo, 'tree', buildTree([]));
    const childOid = setPathInTree(forge, repo, existing === undefined ? emptyTree : existing.oid, rest, blobOid);
    const childEntries = treeEntriesOf(repo, childOid);
    if (childEntries.length > 0) kept.push({ mode: '40000', name: head, oid: childOid });
  }
  return forge.putObject(repo, 'tree', buildTree(kept));
}

/**
 * All commits reachable from `tips`, with their generation (distance from
 * the nearest tip; tips are generation 0). Walks parents breadth-first.
 */
export function reachableCommits(repo: Repo, tips: readonly string[]): Map<string, number> {
  const generations = new Map<string, number>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (isObjectId(tip) && !generations.has(tip)) {
      generations.set(tip, 0);
      queue.push(tip);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head]!;
    head += 1;
    const generation = generations.get(oid)!;
    for (const parent of commitParents(repo, oid)) {
      if (!generations.has(parent)) {
        generations.set(parent, generation + 1);
        queue.push(parent);
      }
    }
  }
  return generations;
}

/** Whether `ancestor` is reachable from `descendant` (or equal). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return reachableCommits(repo, [descendant]).has(ancestor);
}

/** The merge-base of two commits: the common ancestor minimising the generation sum. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = reachableCommits(repo, [a]);
  const fromB = reachableCommits(repo, [b]);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, genA] of fromA) {
    const genB = fromB.get(oid);
    if (genB === undefined) continue;
    const score = genA + genB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** Commits reachable from `tip`, newest-first (timestamp desc, oid tiebreak). */
export function listCommits(repo: Repo, tip: string): string[] {
  const reachable = reachableCommits(repo, [tip]);
  const oids = [...reachable.keys()];
  oids.sort((a, b) => {
    const timeDiff = commitTimestamp(repo, b) - commitTimestamp(repo, a);
    if (timeDiff !== 0) return timeDiff;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return oids;
}

/** One file difference between two trees. */
export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'changed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
  changes: number;
}

/**
 * A line diff between two texts: additions and deletions by longest
 * common subsequence over lines. Small files only in practice; a large
 * input falls back to a multiset difference.
 */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length * newLines.length > 4_000_000) {
    const oldCounts = new Map<string, number>();
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of newLines) {
      const remaining = oldCounts.get(line) ?? 0;
      if (remaining > 0) oldCounts.set(line, remaining - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const remaining of oldCounts.values()) deletions += remaining;
    return { additions, deletions };
  }
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        oldLines[i] === newLines[j]
          ? table[(i + 1) * cols + (j + 1)] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
      deletions += 1;
      i += 1;
    } else {
      additions += 1;
      j += 1;
    }
  }
  deletions += oldLines.length - i;
  additions += newLines.length - j;
  return { additions, deletions };
}

/** The file changes between two trees (base → head). */
export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = new Map<string, TreeEntry>();
  const head = new Map<string, TreeEntry>();
  if (baseTreeOid !== null) flattenTree(repo, baseTreeOid, '', base);
  if (headTreeOid !== null) flattenTree(repo, headTreeOid, '', head);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    if (oldEntry === undefined && newEntry !== undefined) {
      const object = repo.objects.get(newEntry.oid);
      const text = object !== undefined && object.type === 'blob' ? object.data.toString('utf8') : '';
      const lines = text === '' ? 0 : text.split('\n').length;
      changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid, additions: lines, deletions: 0, changes: lines });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const object = repo.objects.get(oldEntry.oid);
      const text = object !== undefined && object.type === 'blob' ? object.data.toString('utf8') : '';
      const lines = text === '' ? 0 : text.split('\n').length;
      changes.push({ path, status: 'changed', oldOid: oldEntry.oid, newOid: null, additions: 0, deletions: lines, changes: lines });
    } else if (oldEntry !== undefined && newEntry !== undefined) {
      const oldObject = repo.objects.get(oldEntry.oid);
      const newObject = repo.objects.get(newEntry.oid);
      const oldText = oldObject !== undefined && oldObject.type === 'blob' ? oldObject.data.toString('utf8') : '';
      const newText = newObject !== undefined && newObject.type === 'blob' ? newObject.data.toString('utf8') : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      changes.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid, additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

/**
 * Whether a pull request merges cleanly: every file changed between the
 * merge-base and the head must be unchanged between the merge-base and
 * the base tip (or changed identically).
 */
export function pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
  const headCommit = pull.head.sha;
  // The base tip is read live: the recorded base sha is a snapshot from
  // creation, and another pull request may have merged since.
  const baseCommit = refCommit(repo, `refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  if (!isObjectId(headCommit) || !isObjectId(baseCommit)) return 'CONFLICTING';
  const base = mergeBase(repo, headCommit, baseCommit);
  if (base === null) return 'CONFLICTING';
  const baseTree = commitTreeOid(repo, base);
  const headTree = commitTreeOid(repo, headCommit);
  const tipTree = commitTreeOid(repo, baseCommit);
  if (baseTree === null || headTree === null || tipTree === null) return 'CONFLICTING';
  const baseFlat = new Map<string, TreeEntry>();
  const headFlat = new Map<string, TreeEntry>();
  const tipFlat = new Map<string, TreeEntry>();
  flattenTree(repo, baseTree, '', baseFlat);
  flattenTree(repo, headTree, '', headFlat);
  flattenTree(repo, tipTree, '', tipFlat);
  const changed = new Set<string>();
  for (const path of new Set([...baseFlat.keys(), ...headFlat.keys()])) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if ((b === undefined) !== (h === undefined) || (b !== undefined && h !== undefined && b.oid !== h.oid)) changed.add(path);
  }
  for (const path of changed) {
    const b = baseFlat.get(path);
    const t = tipFlat.get(path);
    const h = headFlat.get(path);
    const baseOid = b === undefined ? null : b.oid;
    const tipOid = t === undefined ? null : t.oid;
    const headOid = h === undefined ? null : h.oid;
    if (tipOid !== baseOid && tipOid !== headOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/**
 * Squash-merge a pull request: one commit on the base branch applying
 * head's diff (merge-base → head) onto the base tip. Answers the merge
 * commit id, or null when the merge conflicts.
 */
export function squashMerge(forge: Forge, repo: Repo, pull: PullRequest): string | null {
  if (pullMergeable(repo, pull) !== 'MERGEABLE') return null;
  const headCommit = pull.head.sha;
  const baseCommit = refCommit(repo, `refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const base = mergeBase(repo, headCommit, baseCommit);
  if (base === null) return null;
  const baseTree = commitTreeOid(repo, base);
  const headTree = commitTreeOid(repo, headCommit);
  const tipTree = commitTreeOid(repo, baseCommit);
  if (baseTree === null || headTree === null || tipTree === null) return null;
  const baseFlat = new Map<string, TreeEntry>();
  const headFlat = new Map<string, TreeEntry>();
  flattenTree(repo, baseTree, '', baseFlat);
  flattenTree(repo, headTree, '', headFlat);
  let resultTree = tipTree;
  const changedPaths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...changedPaths].sort()) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if ((b === undefined) === (h === undefined) && b !== undefined && h !== undefined && b.oid === h.oid) continue;
    const segments = path.split('/');
    resultTree = setPathInTree(forge, repo, resultTree, segments, h === undefined ? null : h.oid);
  }
  const message = `Merge pull request #${pull.number} from ${pull.head.ref}\n\n${pull.title}`;
  return forge.createCommitOnBranch(repo, pull.base.ref, message, resultTree, [baseCommit]);
}

// ---------------------------------------------------------------- global ids

/** Opaque Relay global id for a repository. */
export function repoGlobalId(owner: string, name: string): string {
  return b64urlEncode(`repo:${owner}:${name}`);
}

/** Opaque Relay global id for an issue. */
export function issueGlobalId(owner: string, repo: string, number: number): string {
  return b64urlEncode(`issue:${owner}:${repo}:${number}`);
}

/** Opaque Relay global id for a pull request. */
export function pullGlobalId(owner: string, repo: string, number: number): string {
  return b64urlEncode(`pr:${owner}:${repo}:${number}`);
}

/** Opaque Relay global id for a comment. */
export function commentGlobalId(owner: string, repo: string, issueNumber: number, commentId: number): string {
  return b64urlEncode(`comment:${owner}:${repo}:${issueNumber}:${commentId}`);
}

/** Decode a global id into its kind and parts, or null. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  const text = b64urlDecode(id);
  if (text === null) return null;
  const parts = text.split(':');
  const kind = parts[0];
  if (kind === undefined || kind === '') return null;
  return { kind, parts: parts.slice(1) };
}

// ---------------------------------------------------------------- 7. HTTP core

/** The largest request body accepted (packs stay well under this). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Read a request body whole. Single-chunk fast path: when the body
 * arrives in one `data` event it is used directly, never copied.
 */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        if (!settled) {
          settled = true;
          reject(new Error('request body too large'));
        }
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) resolve(Buffer.alloc(0));
      else if (chunks.length === 1) resolve(chunks[0]!);
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/** Send a pre-built buffer with the forge's standard headers. */
export function sendBuffer(
  res: ServerResponse,
  forge: Forge,
  status: number,
  body: Buffer,
  contentType: string,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': forge.nextRequestId(),
    ...(extraHeaders ?? {}),
  });
  res.end(body);
}

/** Send a JSON value. */
export function sendJson(
  res: ServerResponse,
  forge: Forge,
  status: number,
  value: unknown,
  extraHeaders?: Record<string, string>,
): void {
  sendBuffer(res, forge, status, Buffer.from(JSON.stringify(value), 'utf8'), 'application/json', extraHeaders);
}

/** Send a JSON error body `{message}`. */
export function sendError(res: ServerResponse, forge: Forge, status: number, message: string): void {
  sendJson(res, forge, status, { message });
}

/** Send a 204 with no body. */
export function sendNoContent(res: ServerResponse, forge: Forge): void {
  res.writeHead(204, { 'x-github-request-id': forge.nextRequestId() });
  res.end();
}

/** Parse a JSON body, or null when it is not valid JSON. */
export function parseJsonBody(body: Buffer): unknown | null {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Whether a value is a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field of a record, or null. */
export function stringField(value: unknown, field: string): string | null {
  if (!isRecord(value)) return null;
  const found = value[field];
  return typeof found === 'string' ? found : null;
}

/** A boolean field of a record, or a default. */
export function booleanField(value: unknown, field: string, fallback: boolean): boolean {
  if (!isRecord(value)) return fallback;
  const found = value[field];
  return typeof found === 'boolean' ? found : fallback;
}

/** Pagination: slice `items` by per_page/page, and the Link header value. */
export function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  req: IncomingMessage,
  basePath: string,
): { page: T[]; link: string | null } {
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, rawPerPage)) : 30;
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const sliced = items.slice(start, start + perPage);
  const host = req.headers.host ?? '127.0.0.1';
  const urlFor = (pageNumber: number): string => {
    const url = new URL(`http://${host}${basePath}`);
    for (const [key, value] of query) {
      if (key !== 'page') url.searchParams.set(key, value);
    }
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(pageNumber));
    return url.toString();
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  if (totalPages > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  return { page: sliced, link: links.length > 0 ? links.join(', ') : null };
}

/** The absolute URL of a path on this forge, from the request's Host. */
export function absoluteUrl(req: IncomingMessage, path: string): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}${path}`;
}

// ---------------------------------------------------------------- REST shapes

/** The REST view of a repository. */
export function repoJson(repo: Repo, req: IncomingMessage): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: absoluteUrl(req, `/${repo.owner}/${repo.name}`),
    url: absoluteUrl(req, base),
    fork: false,
    archived: false,
    disabled: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

/** The REST view of an issue. */
export function issueJson(issue: Issue, repo: Repo, req: IncomingMessage): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: issue.user, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: absoluteUrl(req, `/${repo.owner}/${repo.name}/issues/${issue.number}`),
    url: absoluteUrl(req, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`),
  };
}

/** The REST view of a pull request. */
export function pullJson(pull: PullRequest, repo: Repo, req: IncomingMessage): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull),
    head: { ref: pull.head.ref, sha: pull.head.sha, label: pull.head.label },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: pull.base.label },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: absoluteUrl(req, `/${repo.owner}/${repo.name}/pull/${pull.number}`),
    url: absoluteUrl(req, `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`),
  };
}

/** Clear an issue's memoised GET JSON after any change to it. */
export function touchIssue(issue: Issue): void {
  issue.jsonCache = null;
}

/** The commit a ref points at (tags are peeled to their commit). */
export function refCommit(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') {
    const match = /^object ([0-9a-f]{40})\n/.exec(object.data.toString('utf8'));
    if (match !== null) return match[1]!;
  }
  return null;
}

/** Resolve a ref name (branch, or a 40-hex commit id) to a commit id. */
export function resolveRefToCommit(repo: Repo, ref: string): string | null {
  if (isObjectId(ref)) {
    const object = repo.objects.get(ref);
    return object !== undefined && object.type === 'commit' ? ref : null;
  }
  return refCommit(repo, `refs/heads/${ref}`);
}

// ---------------------------------------------------------------- 8. REST v3

interface RestContext {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  /** Path segments after /api/v3, decoded. */
  segments: string[];
  query: URLSearchParams;
}

/** Dispatch a /api/v3 request. The caller already checked auth. */
async function handleRest(ctx: RestContext): Promise<void> {
  const { forge, req, res, segments } = ctx;
  const method = req.method ?? 'GET';
  const oauth = { 'x-oauth-scopes': 'repo' };

  // GET /api/v3/ — the root.
  if (segments.length === 0) {
    if (method !== 'GET') return sendError(res, forge, 404, 'Not Found');
    return sendJson(
      res,
      forge,
      200,
      {
        current_user_url: absoluteUrl(req, '/api/v3/user'),
        repository_url: absoluteUrl(req, '/api/v3/repos/{owner}/{repo}'),
        meta_url: absoluteUrl(req, '/api/v3/meta'),
      },
      oauth,
    );
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return sendError(res, forge, 404, 'Not Found');
    return sendJson(res, forge, 200, { installed_version: FORGE_VERSION }, oauth);
  }

  // /api/v3/user[/repos]
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return sendError(res, forge, 404, 'Not Found');
      return sendJson(
        res,
        forge,
        200,
        {
          login: VIEWER_LOGIN,
          id: VIEWER_ID,
          name: VIEWER_NAME,
          email: VIEWER_EMAIL,
          type: 'User',
          html_url: absoluteUrl(req, `/${VIEWER_LOGIN}`),
          url: absoluteUrl(req, '/api/v3/user'),
        },
        oauth,
      );
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'POST') {
        const body = await readBody(req);
        const json = parseJsonBody(body);
        if (json === null) return sendError(res, forge, 400, 'Problems parsing JSON');
        const name = stringField(json, 'name');
        if (name === null || name === '') return sendError(res, forge, 422, 'name is required');
        const repo = forge.createRepo(name, booleanField(json, 'private', false), stringField(json, 'description') ?? '');
        if (repo === null) return sendError(res, forge, 422, `Repository ${name} already exists`);
        return sendJson(res, forge, 201, repoJson(repo, req), oauth);
      }
      if (method === 'GET') {
        const owned = [...forge.repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN);
        const { page, link } = paginate(owned, ctx.query, req, '/api/v3/user/repos');
        return sendJson(res, forge, 200, page.map((repo) => repoJson(repo, req)), {
          'x-oauth-scopes': 'repo',
          ...(link !== null ? { link } : {}),
        });
      }
      return sendError(res, forge, 404, 'Not Found');
    }
    return sendError(res, forge, 404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[/...]
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1]!;
    const name = segments[2]!;
    const rest = segments.slice(3);
    return handleRepoRest(ctx, owner, name, rest);
  }

  return sendError(res, forge, 404, 'Not Found');
}

/** Dispatch a /api/v3/repos/{owner}/{repo}/... request. */
async function handleRepoRest(ctx: RestContext, owner: string, name: string, rest: readonly string[]): Promise<void> {
  const { forge, req, res } = ctx;
  const method = req.method ?? 'GET';
  const oauth = { 'x-oauth-scopes': 'repo' };
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return sendError(res, forge, 404, 'Not Found');

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return sendJson(res, forge, 200, repoJson(repo, req), oauth);
    if (method === 'PATCH') {
      const body = await readBody(req);
      const json = parseJsonBody(body);
      if (json === null) return sendError(res, forge, 400, 'Problems parsing JSON');
      const description = stringField(json, 'description');
      if (description !== null) repo.description = description;
      if (isRecord(json) && typeof json.private === 'boolean') repo.private = json.private;
      repo.updatedAt = forge.nextTsIso();
      return sendJson(res, forge, 200, repoJson(repo, req), oauth);
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return sendNoContent(res, forge);
    }
    return sendError(res, forge, 404, 'Not Found');
  }

  const section = rest[0]!;

  // Branches: GET /branches, GET /branches/{branch}
  if (section === 'branches') {
    if (method !== 'GET') return sendError(res, forge, 404, 'Not Found');
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (rest.length === 1) return sendJson(res, forge, 200, branches, oauth);
    if (rest.length === 2) {
      const found = branches.find((branch) => branch.name === rest[1]);
      if (found === undefined) return sendError(res, forge, 404, 'Not Found');
      return sendJson(res, forge, 200, found, oauth);
    }
    return sendError(res, forge, 404, 'Not Found');
  }

  // Git data: /git/refs[/...]
  if (section === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = await readBody(req);
      const json = parseJsonBody(body);
      if (json === null) return sendError(res, forge, 400, 'Problems parsing JSON');
      const ref = stringField(json, 'ref');
      const sha = stringField(json, 'sha');
      if (ref === null || !ref.startsWith('refs/')) return sendError(res, forge, 422, 'ref must start with refs/');
      if (sha === null || !isObjectId(sha)) return sendError(res, forge, 422, 'sha must be an object id');
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') return sendError(res, forge, 422, 'sha is not a known commit');
      if (repo.refs.has(ref)) return sendError(res, forge, 422, `Reference ${ref} already exists`);
      forge.setRef(repo, ref, sha);
      return sendJson(res, forge, 201, { ref, object: { sha } }, oauth);
    }
    if (method === 'GET') {
      if (rest.length === 2) {
        const all = [...repo.refs.entries()]
          .map(([ref, sha]) => ({ ref, object: { sha } }))
          .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
        return sendJson(res, forge, 200, all, oauth);
      }
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return sendError(res, forge, 404, 'Not Found');
      return sendJson(res, forge, 200, { ref, object: { sha } }, oauth);
    }
    return sendError(res, forge, 404, 'Not Found');
  }

  // Commits: GET /commits[?sha=]
  if (section === 'commits') {
    if (method !== 'GET' || rest.length !== 1) return sendError(res, forge, 404, 'Not Found');
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = resolveRefToCommit(repo, ref);
    if (tip === null) return sendJson(res, forge, 200, [], oauth);
    const commits = listCommits(repo, tip).map((sha) => {
      const parsed = parseCommit(repo.objects.get(sha)!.data);
      return {
        sha,
        commit: {
          message: parsed.message,
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
        },
      };
    });
    return sendJson(res, forge, 200, commits, oauth);
  }

  // Contents: PUT/GET/DELETE /contents[/path...]
  if (section === 'contents') {
    return handleContents(ctx, repo, rest.slice(1));
  }

  // Labels: GET/POST /labels
  if (section === 'labels') {
    if (rest.length !== 1) return sendError(res, forge, 404, 'Not Found');
    if (method === 'GET') {
      return sendJson(res, forge, 200, [...repo.labels.values()], oauth);
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const json = parseJsonBody(body);
      if (json === null) return sendError(res, forge, 400, 'Problems parsing JSON');
      const labelName = stringField(json, 'name');
      if (labelName === null || labelName === '') return sendError(res, forge, 422, 'name is required');
      if (repo.labels.has(labelName)) return sendError(res, forge, 422, `Label ${labelName} already exists`);
      const label: Label = { name: labelName, color: stringField(json, 'color') ?? 'ededed' };
      repo.labels.set(labelName, label);
      return sendJson(res, forge, 201, label, oauth);
    }
    return sendError(res, forge, 404, 'Not Found');
  }

  // Issues: /issues[/number[/comments]]
  if (section === 'issues') {
    return handleIssues(ctx, repo, rest.slice(1));
  }

  // Pulls: /pulls[/number[/files|merge]]
  if (section === 'pulls') {
    return handlePulls(ctx, repo, rest.slice(1));
  }

  return sendError(res, forge, 404, 'Not Found');
}

/** The contents API: PUT create/update, GET file or directory, DELETE. */
async function handleContents(ctx: RestContext, repo: Repo, pathSegments: readonly string[]): Promise<void> {
  const { forge, req, res } = ctx;
  const method = req.method ?? 'GET';
  const oauth = { 'x-oauth-scopes': 'repo' };
  const segments = pathSegments.filter((segment) => segment !== '');

  if (method === 'PUT') {
    const body = await readBody(req);
    const json = parseJsonBody(body);
    if (json === null) return sendError(res, forge, 400, 'Problems parsing JSON');
    const message = stringField(json, 'message') ?? '';
    const content = stringField(json, 'content');
    if (content === null) return sendError(res, forge, 422, 'content is required');
    const branch = stringField(json, 'branch') ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const tip = refCommit(repo, refName);
    const tipTree = tip === null ? null : commitTreeOid(repo, tip);
    const current = tipTree === null ? null : blobAtPath(repo, tipTree, segments);
    const givenSha = stringField(json, 'sha');
    if (current !== null) {
      if (givenSha === null || givenSha !== current.oid) {
        return sendError(res, forge, 409, 'sha does not match the current blob');
      }
    }
    const blob = Buffer.from(content, 'base64');
    const blobOid = forge.putObject(repo, 'blob', blob);
    const emptyTree = forge.putObject(repo, 'tree', buildTree([]));
    const newTree = setPathInTree(forge, repo, tipTree ?? emptyTree, segments, blobOid);
    // The message is stored verbatim: the REST API reports it back
    // exactly as given, with no newline appended.
    const commitOid = forge.createCommitOnBranch(repo, branch, message, newTree, tip === null ? [] : [tip]);
    const path = segments.join('/');
    return sendJson(
      res,
      forge,
      current === null ? 201 : 200,
      {
        content: {
          name: segments[segments.length - 1] ?? '',
          path,
          sha: blobOid,
          size: blob.length,
          encoding: 'base64',
          content: blob.toString('base64'),
        },
        commit: { sha: commitOid, message },
      },
      oauth,
    );
  }

  if (method === 'GET') {
    const ref = ctx.query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRefToCommit(repo, ref);
    if (tip === null) return sendError(res, forge, 404, 'Not Found');
    const treeOid = commitTreeOid(repo, tip);
    if (treeOid === null) return sendError(res, forge, 404, 'Not Found');
    if (segments.length === 0) {
      const listing = treeEntriesOf(repo, treeOid).map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
      }));
      return sendJson(res, forge, 200, listing, oauth);
    }
    // Walk to the parent tree, then look the last segment up there.
    const parentSegments = segments.slice(0, -1);
    const last = segments[segments.length - 1]!;
    const parentTree = parentSegments.length === 0 ? treeOid : treeAtPath(repo, treeOid, parentSegments);
    if (parentTree === null) return sendError(res, forge, 404, 'Not Found');
    const entry = treeEntriesOf(repo, parentTree).find((candidate) => candidate.name === last);
    if (entry === undefined) return sendError(res, forge, 404, 'Not Found');
    const path = segments.join('/');
    if (entry.mode === '40000') {
      const listing = treeEntriesOf(repo, entry.oid).map((child) => ({
        type: child.mode === '40000' ? 'dir' : 'file',
        name: child.name,
        path: `${path}/${child.name}`,
        sha: child.oid,
      }));
      return sendJson(res, forge, 200, listing, oauth);
    }
    const object = repo.objects.get(entry.oid);
    if (object === undefined || object.type !== 'blob') return sendError(res, forge, 404, 'Not Found');
    return sendJson(
      res,
      forge,
      200,
      {
        type: 'file',
        encoding: 'base64',
        content: object.data.toString('base64'),
        sha: entry.oid,
        size: object.data.length,
        name: last,
        path,
      },
      oauth,
    );
  }

  if (method === 'DELETE') {
    const body = await readBody(req);
    const json = parseJsonBody(body);
    if (json === null) return sendError(res, forge, 400, 'Problems parsing JSON');
    const message = stringField(json, 'message') ?? '';
    const givenSha = stringField(json, 'sha');
    const tip = refCommit(repo, `refs/heads/${repo.defaultBranch}`);
    if (tip === null) return sendError(res, forge, 404, 'Not Found');
    const tipTree = commitTreeOid(repo, tip);
    if (tipTree === null) return sendError(res, forge, 404, 'Not Found');
    const current = blobAtPath(repo, tipTree, segments);
    if (current === null) return sendError(res, forge, 404, 'Not Found');
    if (givenSha === null || givenSha !== current.oid) {
      return sendError(res, forge, 409, 'sha does not match the current blob');
    }
    const newTree = setPathInTree(forge, repo, tipTree, segments, null);
    const commitOid = forge.createCommitOnBranch(repo, repo.defaultBranch, message, newTree, [tip]);
    return sendJson(res, forge, 200, { commit: { sha: commitOid, message } }, oauth);
  }

  return sendError(res, forge, 404, 'Not Found');
}

/** The issues API: create, list, read, patch, comments. */
async function handleIssues(ctx: RestContext, repo: Repo, rest: readonly string[]): Promise<void> {
  const { forge, req, res } = ctx;
  const method = req.method ?? 'GET';
  const oauth = { 'x-oauth-scopes': 'repo' };

  // POST /issues — create. GET /issues — list.
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = await readBody(req);
      const json = parseJsonBody(body);
      if (json === null) return sendError(res, forge, 400, 'Problems parsing JSON');
      const title = stringField(json, 'title');
      if (title === null || title === '') return sendError(res, forge, 422, 'title is required');
      const labels: Label[] = [];
      if (isRecord(json) && Array.isArray(json.labels)) {
        for (const entry of json.labels) {
          const labelName = typeof entry === 'string' ? entry : stringField(entry, 'name');
          if (labelName === null) return sendError(res, forge, 422, 'labels must name labels');
          const label = repo.labels.get(labelName);
          if (label === undefined) return sendError(res, forge, 422, `Label '${labelName}' does not exist`);
          labels.push(label);
        }
      }
      const now = forge.nextTsIso();
      const issue: Issue = {
        id: forge.nextIssueId,
        number: repo.nextIssueNumber,
        title,
        body: stringField(json, 'body') ?? '',
        state: 'open',
        labels,
        user: VIEWER_LOGIN,
        createdAt: now,
        updatedAt: now,
        comments: [],
        jsonCache: null,
      };
      forge.nextIssueId += 1;
      repo.nextIssueNumber += 1;
      repo.issues.push(issue);
      return sendJson(res, forge, 201, issueJson(issue, repo, req), oauth);
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      const labelsParam = ctx.query.get('labels');
      let listed = [...repo.issues];
      if (state === 'open') listed = listed.filter((issue) => issue.state === 'open');
      else if (state === 'closed') listed = listed.filter((issue) => issue.state === 'closed');
      if (labelsParam !== null && labelsParam !== '') {
        const wanted = labelsParam.split(',').map((name) => name.trim()).filter((name) => name !== '');
        listed = listed.filter((issue) => wanted.every((name) => issue.labels.some((label) => label.name === name)));
      }
      if (sort === 'created') {
        listed.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { page, link } = paginate(listed, ctx.query, req, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      return sendJson(res, forge, 200, page.map((issue) => issueJson(issue, repo, req)), {
        'x-oauth-scopes': 'repo',
        ...(link !== null ? { link } : {}),
      });
    }
    return sendError(res, forge, 404, 'Not Found');
  }

  // /issues/{number}[/comments]
  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number)) return sendError(res, forge, 404, 'Not Found');
  const issue = repo.issues.find((candidate) => candidate.number === number);
  if (issue === undefined) return sendError(res, forge, 404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') {
      // Hot path (the read workload): a memoised JSON buffer.
      if (issue.jsonCache !== null) {
        return sendBuffer(res, forge, 200, issue.jsonCache, 'application/json', oauth);
      }
      const buffer = Buffer.from(JSON.stringify(issueJson(issue, repo, req)), 'utf8');
      issue.jsonCache = buffer;
      return sendBuffer(res, forge, 200, buffer, 'application/json', oauth);
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const json = parseJsonBody(body);
      if (json === null) return sendError(res, forge, 400, 'Problems parsing JSON');
      const state = stringField(json, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = stringField(json, 'title');
      if (title !== null) issue.title = title;
      const bodyText = stringField(json, 'body');
      if (bodyText !== null) issue.body = bodyText;
      issue.updatedAt = forge.nextTsIso();
      touchIssue(issue);
      return sendJson(res, forge, 200, issueJson(issue, repo, req), oauth);
    }
    return sendError(res, forge, 404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const body = await readBody(req);
      const json = parseJsonBody(body);
      if (json === null) return sendError(res, forge, 400, 'Problems parsing JSON');
      const text = stringField(json, 'body');
      if (text === null || text === '') return sendError(res, forge, 422, 'body is required');
      const comment: IssueComment = {
        id: forge.nextCommentId,
        body: text,
        user: VIEWER_LOGIN,
        createdAt: forge.nextTsIso(),
      };
      forge.nextCommentId += 1;
      issue.comments.push(comment);
      touchIssue(issue);
      return sendJson(
        res,
        forge,
        201,
        { id: comment.id, body: comment.body, user: { login: comment.user, id: VIEWER_ID, type: 'User' }, created_at: comment.createdAt },
        oauth,
      );
    }
    if (method === 'GET') {
      const listed = issue.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: comment.user, id: VIEWER_ID, type: 'User' },
        created_at: comment.createdAt,
      }));
      return sendJson(res, forge, 200, listed, oauth);
    }
    return sendError(res, forge, 404, 'Not Found');
  }

  return sendError(res, forge, 404, 'Not Found');
}

/** The pull requests API: create, list, read, files, merge. */
async function handlePulls(ctx: RestContext, repo: Repo, rest: readonly string[]): Promise<void> {
  const { forge, req, res } = ctx;
  const method = req.method ?? 'GET';
  const oauth = { 'x-oauth-scopes': 'repo' };

  // POST /pulls — create. GET /pulls — list.
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = await readBody(req);
      const json = parseJsonBody(body);
      if (json === null) return sendError(res, forge, 400, 'Problems parsing JSON');
      const head = stringField(json, 'head');
      const base = stringField(json, 'base');
      const title = stringField(json, 'title');
      if (head === null || head === '') return sendError(res, forge, 422, 'head is required');
      if (base === null || base === '') return sendError(res, forge, 422, 'base is required');
      if (title === null || title === '') return sendError(res, forge, 422, 'title is required');
      const headSha = refCommit(repo, `refs/heads/${head}`);
      const baseSha = refCommit(repo, `refs/heads/${base}`);
      if (headSha === null) return sendError(res, forge, 422, `head branch ${head} does not exist`);
      if (baseSha === null) return sendError(res, forge, 422, `base branch ${base} does not exist`);
      if (headSha === baseSha) return sendError(res, forge, 422, 'No commits between head and base');
      const duplicate = repo.pulls.find(
        (pull) => pull.state === 'open' && pull.head.ref === head && pull.base.ref === base,
      );
      if (duplicate !== undefined) return sendError(res, forge, 422, 'A pull request already exists for these branches');
      const now = forge.nextTsIso();
      const pull: PullRequest = {
        id: forge.nextPullId,
        number: repo.nextPullNumber,
        title,
        body: stringField(json, 'body') ?? '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        head: { ref: head, sha: headSha, label: `${repo.owner}:${head}` },
        base: { ref: base, sha: baseSha, label: `${repo.owner}:${base}` },
        createdAt: now,
        updatedAt: now,
      };
      forge.nextPullId += 1;
      repo.nextPullNumber += 1;
      repo.pulls.push(pull);
      return sendJson(res, forge, 201, pullJson(pull, repo, req), oauth);
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let listed = [...repo.pulls];
      if (state === 'open') listed = listed.filter((pull) => pull.state === 'open');
      else if (state === 'closed') listed = listed.filter((pull) => pull.state === 'closed');
      listed.sort((a, b) => a.number - b.number);
      const { page, link } = paginate(listed, ctx.query, req, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      return sendJson(res, forge, 200, page.map((pull) => pullJson(pull, repo, req)), {
        'x-oauth-scopes': 'repo',
        ...(link !== null ? { link } : {}),
      });
    }
    return sendError(res, forge, 404, 'Not Found');
  }

  const number = Number.parseInt(rest[0]!, 10);
  if (!Number.isInteger(number)) return sendError(res, forge, 404, 'Not Found');
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) return sendError(res, forge, 404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return sendJson(res, forge, 200, pullJson(pull, repo, req), oauth);
    return sendError(res, forge, 404, 'Not Found');
  }

  // GET /pulls/{n}/files
  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') return sendError(res, forge, 404, 'Not Found');
    const baseTree = commitTreeOid(repo, pull.base.sha);
    const headTree = commitTreeOid(repo, pull.head.sha);
    const changes = diffTrees(repo, baseTree, headTree);
    return sendJson(
      res,
      forge,
      200,
      changes.map((change) => ({
        filename: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
      })),
      oauth,
    );
  }

  // PUT /pulls/{n}/merge
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') return sendError(res, forge, 404, 'Not Found');
    if (pull.merged) return sendError(res, forge, 405, 'Pull request already merged');
    const sha = squashMerge(forge, repo, pull);
    if (sha === null) return sendError(res, forge, 405, 'Merge conflict');
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = forge.nextTsIso();
    pull.mergeCommitSha = sha;
    pull.base.sha = sha;
    pull.updatedAt = forge.nextTsIso();
    return sendJson(res, forge, 200, { sha, merged: true, message: `Pull request #${pull.number} merged` }, oauth);
  }

  return sendError(res, forge, 404, 'Not Found');
}

// ---------------------------------------------------------------- 9. git smart HTTP

/** Refs sorted by name, with peeled tag targets resolved. */
export function sortedRefs(repo: Repo): Array<{ ref: string; oid: string; peeled: string | null }> {
  const out: Array<{ ref: string; oid: string; peeled: string | null }> = [];
  for (const ref of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(ref)!;
    let peeled: string | null = null;
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})\n/.exec(object.data.toString('utf8'));
      if (match !== null) peeled = match[1]!;
    }
    out.push({ ref, oid, peeled });
  }
  return out;
}

/** The v2 advertisement capabilities. */
export function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${FORGE_AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

/** The v0 advertisement for a service, with its capability line. */
export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/main agent=${FORGE_AGENT} side-band-64k thin-pack ofs-delta multi_ack_detailed`
      : `symref=HEAD:refs/heads/main agent=${FORGE_AGENT} report-status side-band-64k delete-refs`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = refCommit(repo, 'refs/heads/main') ?? repo.refs.get('refs/heads/main') ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.ref}\n`));
      if (ref.peeled !== null) parts.push(pktLine(`${ref.peeled} ${ref.ref}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The ls-refs answer for a repo (full list, or filtered by prefixes). */
export function lsRefsResponse(
  repo: Repo,
  prefixes: readonly string[],
  wantPeel: boolean,
  wantSymrefs: boolean,
  wantUnborn: boolean,
): Buffer {
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    if (wantUnborn) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  } else {
    const headOid = refCommit(repo, 'refs/heads/main') ?? repo.refs.get('refs/heads/main') ?? ZERO_OID;
    const headLine = wantSymrefs ? `${headOid} HEAD symref-target:refs/heads/main\n` : `${headOid} HEAD\n`;
    if (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) parts.push(pktLine(headLine));
    for (const ref of refs) {
      if (prefixes.length > 0 && !prefixes.some((prefix) => ref.ref.startsWith(prefix))) continue;
      let line = `${ref.oid} ${ref.ref}`;
      if (wantPeel && ref.peeled !== null) line += ` peeled:${ref.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The tree closure (trees + blobs) of a set of commits, as oid → object. */
export function closureOfCommits(repo: Repo, commits: Iterable<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const visitTree = (treeOid: string): void => {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree' || out.has(treeOid)) return;
    out.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') visitTree(entry.oid);
      else {
        const blob = repo.objects.get(entry.oid);
        if (blob !== undefined && !out.has(entry.oid)) out.set(entry.oid, blob);
      }
    }
  };
  for (const commitOid of commits) {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit' || out.has(commitOid)) continue;
    out.set(commitOid, commit);
    const treeOid = parseCommit(commit.data).tree;
    visitTree(treeOid);
  }
  return out;
}

export interface FetchSelection {
  objects: PackObjectInput[];
  ack: string | null;
  shallow: string[];
  unshallow: string[];
}

/** Peel a tag (possibly through other tags) to the commit it points at, or null. */
export function peelTagToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})\n/.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1]!;
  }
  return null;
}

/**
 * The fetch object selection. `wants` are the tips, `haves` the commits
 * the client already holds, `shallows` its shallow boundaries, `deepen`
 * a depth limit (null = full fetch). Generation 1 is a want itself.
 *
 * Held commits are reachable(haves), except the walk stops at a shallow
 * boundary (a shallow commit's parents are not held). The ack is the
 * last have that is an ancestor of a want, else null (NAK).
 */
export function selectFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallows: readonly string[],
  deepen: number | null,
): FetchSelection {
  const shallowSet = new Set(shallows);
  // A want may be an annotated tag: peel it to its commit for the walk,
  // but remember the tag object itself — it travels in the pack too.
  const tagObjects: string[] = [];
  const peeledWants: string[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type === 'tag') {
      tagObjects.push(want);
      const target = peelTagToCommit(repo, want);
      if (target !== null) peeledWants.push(target);
    } else {
      peeledWants.push(want);
    }
  }
  const wantGens = reachableCommits(repo, peeledWants);
  let ack: string | null = null;
  for (const have of haves) {
    if (wantGens.has(have)) ack = have;
  }
  // Held commits: walk from the haves, never past a shallow boundary.
  const heldCommits = new Map<string, number>();
  const queue: string[] = [];
  for (const have of haves) {
    if (isObjectId(have) && !heldCommits.has(have)) {
      heldCommits.set(have, 0);
      queue.push(have);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head]!;
    head += 1;
    if (shallowSet.has(oid)) continue;
    for (const parent of commitParents(repo, oid)) {
      if (!heldCommits.has(parent)) {
        heldCommits.set(parent, 0);
        queue.push(parent);
      }
    }
  }
  const heldObjects = closureOfCommits(repo, heldCommits.keys());
  const delivered: string[] = [];
  if (deepen === null) {
    for (const oid of wantGens.keys()) {
      if (!heldCommits.has(oid)) delivered.push(oid);
    }
  } else {
    for (const [oid, generation] of wantGens) {
      if (generation + 1 <= deepen && !heldCommits.has(oid)) delivered.push(oid);
    }
  }
  const sendObjects = closureOfCommits(repo, delivered);
  for (const tagOid of tagObjects) {
    const tag = repo.objects.get(tagOid);
    if (tag !== undefined) sendObjects.set(tagOid, tag);
  }
  const byType = new Map<string, GitObject>();
  for (const [oid, object] of sendObjects) {
    if (!heldObjects.has(oid)) byType.set(oid, object);
  }
  // Deterministic order: commits by generation, then trees, then blobs.
  const commits: PackObjectInput[] = [];
  const trees: PackObjectInput[] = [];
  const blobs: PackObjectInput[] = [];
  const tags: PackObjectInput[] = [];
  const deliveredGens = new Map<string, number>();
  for (const oid of delivered) deliveredGens.set(oid, wantGens.get(oid) ?? 0);
  for (const object of byType.values()) {
    if (object.type === 'commit') commits.push(object);
    else if (object.type === 'tree') trees.push(object);
    else if (object.type === 'blob') blobs.push(object);
    else tags.push(object);
  }
  commits.sort((a, b) => {
    const aOid = hashObject('commit', a.data);
    const bOid = hashObject('commit', b.data);
    return (deliveredGens.get(aOid) ?? 0) - (deliveredGens.get(bOid) ?? 0) || (aOid < bOid ? -1 : 1);
  });
  const byOid = (a: PackObjectInput, b: PackObjectInput): number => {
    const aOid = hashObject(a.type, a.data);
    const bOid = hashObject(b.type, b.data);
    return aOid < bOid ? -1 : aOid > bOid ? 1 : 0;
  };
  trees.sort(byOid);
  blobs.sort(byOid);
  tags.sort(byOid);
  const objects = [...commits, ...trees, ...blobs, ...tags];
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (deepen !== null) {
    const deliveredSet = new Set(delivered);
    shallow = delivered.filter(
      (oid) => wantGens.get(oid)! + 1 === deepen && commitParents(repo, oid).length > 0,
    );
    unshallow = shallows.filter((oid) => deliveredSet.has(oid) && (wantGens.get(oid) ?? 0) + 1 < deepen);
  }
  return { objects, ack, shallow, unshallow };
}

/** Build the v2 fetch response for a selection. */
export function fetchResponseV2(selection: FetchSelection): Buffer {
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  parts.push(pktLine(selection.ack !== null ? `ACK ${selection.ack}\n` : 'NAK\n'));
  parts.push(pktDelim());
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (selection.objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    const pack = writePack(selection.objects);
    for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Build the v0 fetch response for a selection. */
export function fetchResponseV0(selection: FetchSelection): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(selection.ack !== null ? `ACK ${selection.ack}\n` : 'NAK\n'));
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (selection.objects.length > 0) {
    const pack = writePack(selection.objects);
    for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleGitInfoRefs(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  query: URLSearchParams,
): void {
  const service = query.get('service');
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return sendError(res, forge, 404, 'Not Found');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return sendError(res, forge, 400, 'service is required');
  }
  const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const cacheKey = isV2 ? 'v2up' : service === 'git-upload-pack' ? 'v0up' : 'v0rp';
  let body = repo.advCache.get(cacheKey);
  if (body === undefined) {
    body = isV2 ? advertisementV2() : advertisementV0(repo, service);
    repo.advCache.set(cacheKey, body);
  }
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  return sendBuffer(res, forge, 200, body, contentType);
}

/** POST /{owner}/{repo}.git/git-upload-pack — ls-refs, fetch v2, fetch v0. */
export async function handleGitUploadPack(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
): Promise<void> {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return sendError(res, forge, 404, 'Not Found');
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    return sendError(res, forge, 400, 'Bad Request');
  }
  let parsed: { lines: PktLine[]; rest: Buffer };
  try {
    parsed = parsePktLines(body);
  } catch {
    // A malformed POST must not crash the server (repo-survives-errors).
    res.writeHead(400, { 'content-type': 'text/plain', 'x-github-request-id': forge.nextRequestId() });
    res.end('bad request');
    return;
  }
  const texts = pktLineTexts(parsed.lines);
  const first = texts[0] ?? '';
  if (first === 'command=ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const text of texts.slice(1)) {
      if (text === 'peel') peel = true;
      else if (text === 'symrefs') symrefs = true;
      else if (text === 'unborn') unborn = true;
      else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    }
    let out: Buffer;
    if (prefixes.length === 0 && peel && symrefs && unborn) {
      if (repo.lsRefsCache === null || repo.lsRefsVersion !== repo.version) {
        repo.lsRefsCache = lsRefsResponse(repo, [], true, true, true);
        repo.lsRefsVersion = repo.version;
      }
      out = repo.lsRefsCache;
    } else {
      out = lsRefsResponse(repo, prefixes, peel, symrefs, unborn);
    }
    return sendBuffer(res, forge, 200, out, 'application/x-git-upload-pack-result');
  }
  if (first === 'command=fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallows: string[] = [];
    let deepen: number | null = null;
    for (const text of texts.slice(1)) {
      if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallows.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) {
        const n = Number.parseInt(text.slice(7).trim(), 10);
        if (Number.isFinite(n)) deepen = n;
      }
    }
    const cacheKey = `${wants.join(',')}|${haves.join(',')}|${shallows.join(',')}|${deepen === null ? '' : deepen}`;
    let selection: FetchSelection;
    if (deepen === 1 && haves.length === 0 && wants.length === 1) {
      const tip = wants[0]!;
      const cached = repo.fetchPackCache.get(cacheKey);
      // The cached pack is valid for this tip whatever the shallow list
      // is, but the fast response below assumes a `shallow <tip>` line:
      // only use it when the tip actually has a parent to cut off.
      if (cached !== undefined && commitParents(repo, tip).length > 0) {
        const out = Buffer.concat([
          pktLine('acknowledgments\n'),
          pktLine('NAK\n'),
          pktDelim(),
          pktLine('shallow-info\n'),
          pktLine(`shallow ${tip}\n`),
          pktDelim(),
          pktLine('packfile\n'),
          ...sidebandPackets(1, cached),
          pktFlush(),
        ]);
        return sendBuffer(res, forge, 200, out, 'application/x-git-upload-pack-result');
      }
      selection = selectFetch(repo, wants, haves, shallows, deepen);
      if (selection.objects.length > 0) {
        repo.fetchPackCache.set(cacheKey, writePack(selection.objects));
      }
    } else {
      selection = selectFetch(repo, wants, haves, shallows, deepen);
    }
    return sendBuffer(res, forge, 200, fetchResponseV2(selection), 'application/x-git-upload-pack-result');
  }
  if (first.startsWith('want ')) {
    // v0 fetch: wants/shallow/deepen before the flush, haves after it.
    const wants: string[] = [];
    const shallows: string[] = [];
    let deepen: number | null = null;
    for (const text of texts) {
      if (text.startsWith('want ')) wants.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) shallows.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) {
        const n = Number.parseInt(text.slice(7).trim(), 10);
        if (Number.isFinite(n)) deepen = n;
      }
    }
    const haves: string[] = [];
    try {
      const second = parsePktLines(parsed.rest);
      for (const text of pktLineTexts(second.lines)) {
        if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      }
    } catch {
      // A malformed second section is not fatal; treat haves as empty.
    }
    const selection = selectFetch(repo, wants, haves, shallows, deepen);
    return sendBuffer(res, forge, 200, fetchResponseV0(selection), 'application/x-git-upload-pack-result');
  }
  res.writeHead(400, { 'content-type': 'text/plain', 'x-github-request-id': forge.nextRequestId() });
  res.end('bad request');
}

/** One receive-pack command line. */
interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack. */
export async function handleGitReceivePack(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
): Promise<void> {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return sendError(res, forge, 404, 'Not Found');
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    return sendError(res, forge, 400, 'Bad Request');
  }
  let parsed: { lines: PktLine[]; rest: Buffer };
  try {
    parsed = parsePktLines(body);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain', 'x-github-request-id': forge.nextRequestId() });
    res.end('bad request');
    return;
  }
  const texts = pktLineTexts(parsed.lines);
  const commands: PushCommand[] = [];
  for (const raw of texts) {
    const nul = raw.indexOf('\0');
    const line = nul < 0 ? raw : raw.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const oldOid = parts[0]!;
    const newOid = parts[1]!;
    const ref = parts.slice(2).join(' ');
    if (!isObjectId(oldOid) || !isObjectId(newOid) || ref === '') continue;
    commands.push({ oldOid, newOid, ref });
  }
  const pack = parsed.rest;
  let unpackOk = true;
  let unpackDetail = '';
  let objectCount = 0;
  if (pack.length > 0) {
    try {
      const read = readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
      objectCount = read.objects.size;
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    let ok = false;
    let reason = '';
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === command.oldOid && current !== ZERO_OID) ok = true;
      else reason = 'non-fast-forward';
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (current === ZERO_OID) {
        if (repo.objects.has(command.newOid)) ok = true;
        else reason = 'object not found';
      } else reason = 'non-fast-forward';
    } else {
      // Update: fast-forward only.
      if (current !== command.oldOid) reason = 'non-fast-forward';
      else if (!repo.objects.has(command.newOid)) reason = 'object not found';
      else if (!isAncestor(repo, command.oldOid, command.newOid)) reason = 'non-fast-forward';
      else ok = true;
    }
    if (ok) {
      if (command.newOid === ZERO_OID) forge.deleteRef(repo, command.ref);
      else forge.setRef(repo, command.ref, command.newOid);
    }
    results.push({ ref: command.ref, ok, reason });
  }
  const reportParts: Buffer[] = [];
  if (unpackOk) reportParts.push(pktLine('unpack ok\n'));
  else reportParts.push(pktLine(`unpack ${unpackDetail}\n`));
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(pktFlush());
  const report = Buffer.concat(reportParts);
  const outParts: Buffer[] = [...sidebandPackets(1, report)];
  if (objectCount > 0) outParts.push(sidebandPacket(2, `Counting objects: ${objectCount}, done.\n`));
  outParts.push(pktFlush());
  return sendBuffer(res, forge, 200, Buffer.concat(outParts), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------- 10. GraphQL

/** One lexed GraphQL token. */
interface GqlToken {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
}

/** Lex a GraphQL document. Commas and comments are insignificant. */
export function lexGraphQL(source: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let pos = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (pos < source.length) {
    const ch = source[pos]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      pos += 1;
      continue;
    }
    if (ch === '#') {
      while (pos < source.length && source[pos] !== '\n') pos += 1;
      continue;
    }
    if (ch === '.' && source.slice(pos, pos + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      pos += 3;
      continue;
    }
    if ('{}()[]:!=$@='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      pos += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      pos += 1;
      while (pos < source.length && source[pos] !== '"') {
        const c = source[pos]!;
        if (c === '\\' && pos + 1 < source.length) {
          const esc = source[pos + 1]!;
          if (esc === 'u' && pos + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(pos + 2, pos + 6), 16));
            pos += 6;
          } else {
            value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
            pos += 2;
          }
        } else {
          value += c;
          pos += 1;
        }
      }
      pos += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let end = pos;
      if (source[end] === '-') end += 1;
      while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      let isFloat = false;
      if (source[end] === '.') {
        isFloat = true;
        end += 1;
        while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      }
      if (source[end] === 'e' || source[end] === 'E') {
        isFloat = true;
        end += 1;
        if (source[end] === '+' || source[end] === '-') end += 1;
        while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(pos, end) });
      pos = end;
      continue;
    }
    if (isNameStart(ch)) {
      let end = pos;
      while (end < source.length && isNameChar(source[end]!)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(pos, end) });
      pos = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

/** A GraphQL value literal (before variables are substituted). */
export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

export interface GqlField {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selections: GqlSelection[] | null;
}

export interface GqlFragment {
  kind: 'fragment';
  typeCondition: string | null;
  selections: GqlSelection[];
}

export type GqlSelection = GqlField | GqlFragment;

export interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Map<string, GqlValue | null>;
  selections: GqlSelection[];
}

/** A tiny recursive-descent parser for the documents this forge serves. */
export class GqlParser {
  tokens: GqlToken[];
  pos: number;
  fragments: Map<string, GqlFragment>;

  constructor(tokens: GqlToken[]) {
    this.tokens = tokens;
    this.pos = 0;
    this.fragments = new Map<string, GqlFragment>();
  }

  peek(): GqlToken | undefined {
    return this.tokens[this.pos];
  }

  next(): GqlToken {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${token.value}`);
    }
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${token.value}`);
    return token.value;
  }

  skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArguments();
    }
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variables: new Map(), selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        const variables = new Map<string, GqlValue | null>();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
          this.next();
          while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            let defaultValue: GqlValue | null = null;
            if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
              this.next();
              defaultValue = this.parseValue();
            }
            variables.set(varName, defaultValue);
          }
          this.expectPunct(')');
        }
        this.skipDirectives();
        operations.push({ type, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        if (this.next().value !== 'on') throw new Error('expected on in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        this.fragments.set(fragName, { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${token.value} in GraphQL document`);
    }
    return operations;
  }

  parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else if (token?.kind === 'name') {
      this.next();
    } else {
      throw new Error('expected a type in GraphQL document');
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'spread') {
        this.next();
        const next = this.peek();
        if (next?.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        } else if (next?.kind === 'name') {
          const fragName = this.next().value;
          this.skipDirectives();
          const fragment = this.fragments.get(fragName);
          if (fragment === undefined) throw new Error(`unknown fragment ${fragName}`);
          selections.push(fragment);
        } else {
          this.skipDirectives();
          selections.push({ kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() });
        }
        continue;
      }
      const name = this.expectName();
      let alias: string | null = null;
      let fieldName = name;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
        this.next();
        alias = name;
        fieldName = this.expectName();
      }
      const args = this.peek()?.kind === 'punct' && this.peek()?.value === '(' ? this.parseArguments() : [];
      this.skipDirectives();
      const sub =
        this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name: fieldName, args, selections: sub });
    }
    this.expectPunct('}');
    return selections;
  }

  parseArguments(): Array<{ name: string; value: GqlValue }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: GqlValue }> = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

/** Substitute variables into a parsed value. */
export function resolveGqlValue(node: GqlValue, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveGqlValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveGqlValue(field.value, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------ schema + runtime

/** The fields each type offers (used for validation and introspection). */
export const GQL_SCHEMA_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PullRequestFileConnection: ['nodes'],
  PullRequestFile: ['path'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  CommentEdge: ['node'],
  Comment: ['id', 'body'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'COMMIT'];

/** A resolved node the executor walks. */
export type GqlRuntime = Record<string, unknown> & { __typename: string };

export function viewerRuntime(): GqlRuntime {
  return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
}

export function repoRuntime(forge: Forge, repo: Repo): GqlRuntime {
  return {
    __typename: 'Repository',
    _forge: forge,
    _repo: repo,
    id: repoGlobalId(repo.owner, repo.name),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: viewerRuntime(),
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

export function issueRuntime(repo: Repo, issue: Issue): GqlRuntime {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: issueGlobalId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

export function pullRuntime(forge: Forge, repo: Repo, pull: PullRequest): GqlRuntime {
  return {
    __typename: 'PullRequest',
    _forge: forge,
    _repo: repo,
    _pull: pull,
    id: pullGlobalId(repo.owner, repo.name, pull.number),
    number: pull.number,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    mergeable: pullMergeable(repo, pull),
  };
}

/** The GraphQL execution context: the forge and the operation's errors. */
export interface GqlContext {
  forge: Forge;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

type GqlResolver = (parent: GqlRuntime, args: Record<string, unknown>, ctx: GqlContext) => unknown;

/** Repository field resolvers that need the store. */
const REPO_RESOLVERS: Record<string, GqlResolver> = {
  issue: (parent, args) => {
    const repo = parent._repo as Repo;
    const number = args.number;
    if (typeof number !== 'number') return null;
    const issue = repo.issues.find((candidate) => candidate.number === number);
    return issue === undefined ? null : issueRuntime(repo, issue);
  },
  issues: (parent, args) => {
    const repo = parent._repo as Repo;
    let listed = [...repo.issues];
    const states = args.states;
    if (Array.isArray(states)) {
      const wanted = new Set(states.map((state) => String(state).toLowerCase()));
      listed = listed.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = args.orderBy;
    let direction = 'asc';
    if (isRecord(orderBy) && typeof orderBy.direction === 'string') direction = orderBy.direction.toLowerCase();
    listed.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
    const after = args.after;
    if (typeof after === 'string' && after !== '') {
      const decoded = b64urlDecode(after);
      const match = decoded !== null ? /^cursor:(\d+)$/.exec(decoded) : null;
      if (match !== null) {
        const cursorNumber = Number(match[1]);
        listed = direction === 'desc' ? listed.filter((issue) => issue.number < cursorNumber) : listed.filter((issue) => issue.number > cursorNumber);
      }
    }
    const first = args.first;
    const total = listed.length;
    const sliced = typeof first === 'number' ? listed.slice(0, first) : listed;
    const hasNextPage = sliced.length < total;
    const last = sliced[sliced.length - 1];
    return {
      __typename: 'IssueConnection',
      nodes: sliced.map((issue) => issueRuntime(repo, issue)),
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage,
        endCursor: last === undefined ? null : b64urlEncode(`cursor:${last.number}`),
      },
      totalCount: total,
    };
  },
  pullRequests: (parent, args) => {
    const repo = parent._repo as Repo;
    const listed = repo.pulls.filter((pull) => pull.state === 'open').sort((a, b) => a.number - b.number);
    const first = args.first;
    const sliced = typeof first === 'number' ? listed.slice(0, first) : listed;
    const forge = parent._forge as Forge;
    return {
      __typename: 'PullRequestConnection',
      nodes: sliced.map((pull) => pullRuntime(forge, repo, pull)),
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage: sliced.length < listed.length,
        endCursor: null,
      },
    };
  },
  pullRequest: (parent, args) => {
    const repo = parent._repo as Repo;
    const number = args.number;
    if (typeof number !== 'number') return null;
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) return null;
    return pullRuntime(parent._forge as Forge, repo, pull);
  },
};

/** PullRequest field resolvers that need the store. */
const PULL_RESOLVERS: Record<string, GqlResolver> = {
  files: (parent, args) => {
    const repo = parent._repo as Repo;
    const pull = parent._pull as PullRequest;
    const baseTree = commitTreeOid(repo, pull.base.sha);
    const headTree = commitTreeOid(repo, pull.head.sha);
    const changes = diffTrees(repo, baseTree, headTree);
    const first = args.first;
    const sliced = typeof first === 'number' ? changes.slice(0, first) : changes;
    return {
      __typename: 'PullRequestFileConnection',
      nodes: sliced.map((change) => ({ __typename: 'PullRequestFile', path: change.path })),
    };
  },
};

/** The __type introspection resolver. */
function typeRuntime(name: string): GqlRuntime | null {
  if (name === 'SearchType') {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      description: '',
      _fields: [],
      _enumValues: SEARCH_TYPE_VALUES.map((value) => ({ __typename: '__EnumValue', name: value, description: '' })),
    };
  }
  const fields = GQL_SCHEMA_FIELDS[name];
  if (fields === undefined) return null;
  return {
    __typename: '__Type',
    name,
    kind: 'OBJECT',
    description: '',
    _fields: fields.map((field) => ({
      __typename: '__Field',
      name: field,
      description: '',
      args: [],
      type: { __typename: '__Type', name: 'String', kind: 'SCALAR' },
    })),
    _enumValues: null,
  };
}

/** Create an issue in the store (shared by REST-shaped and GraphQL paths). */
export function createIssueInternal(forge: Forge, repo: Repo, title: string, body: string): Issue {
  const now = forge.nextTsIso();
  const issue: Issue = {
    id: forge.nextIssueId,
    number: repo.nextIssueNumber,
    title,
    body,
    state: 'open',
    labels: [],
    user: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
    comments: [],
    jsonCache: null,
  };
  forge.nextIssueId += 1;
  repo.nextIssueNumber += 1;
  repo.issues.push(issue);
  return issue;
}

/** Create a pull request in the store; null when the branches do not allow it. */
export function createPullInternal(
  forge: Forge,
  repo: Repo,
  head: string,
  base: string,
  title: string,
  body: string,
): PullRequest | null {
  const headSha = refCommit(repo, `refs/heads/${head}`);
  const baseSha = refCommit(repo, `refs/heads/${base}`);
  if (headSha === null || baseSha === null || headSha === baseSha) return null;
  const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.head.ref === head && pull.base.ref === base);
  if (duplicate !== undefined) return null;
  const now = forge.nextTsIso();
  const pull: PullRequest = {
    id: forge.nextPullId,
    number: repo.nextPullNumber,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head: { ref: head, sha: headSha, label: `${repo.owner}:${head}` },
    base: { ref: base, sha: baseSha, label: `${repo.owner}:${base}` },
    createdAt: now,
    updatedAt: now,
  };
  forge.nextPullId += 1;
  repo.nextPullNumber += 1;
  repo.pulls.push(pull);
  return pull;
}

const QUERY_RESOLVERS: Record<string, GqlResolver> = {
  viewer: () => viewerRuntime(),
  repository: (parent, args, ctx) => {
    const owner = args.owner;
    const name = args.name;
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    const repo = ctx.forge.getRepo(owner, name);
    return repo === undefined ? null : repoRuntime(ctx.forge, repo);
  },
  node: (parent, args, ctx) => {
    const id = args.id;
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    if (decoded.kind === 'repo') {
      const [owner, name] = decoded.parts;
      if (owner === undefined || name === undefined) return null;
      const repo = ctx.forge.getRepo(owner, name);
      return repo === undefined ? null : repoRuntime(ctx.forge, repo);
    }
    if (decoded.kind === 'issue') {
      const [owner, name, numberText] = decoded.parts;
      const number = Number(numberText);
      if (owner === undefined || name === undefined || !Number.isInteger(number)) return null;
      const repo = ctx.forge.getRepo(owner, name);
      if (repo === undefined) return null;
      const issue = repo.issues.find((candidate) => candidate.number === number);
      return issue === undefined ? null : issueRuntime(repo, issue);
    }
    if (decoded.kind === 'pr') {
      const [owner, name, numberText] = decoded.parts;
      const number = Number(numberText);
      if (owner === undefined || name === undefined || !Number.isInteger(number)) return null;
      const repo = ctx.forge.getRepo(owner, name);
      if (repo === undefined) return null;
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      return pull === undefined ? null : pullRuntime(ctx.forge, repo, pull);
    }
    return null;
  },
  __type: (parent, args) => {
    const name = args.name;
    if (typeof name !== 'string') return null;
    return typeRuntime(name);
  },
};

const MUTATION_RESOLVERS: Record<string, GqlResolver> = {
  createIssue: (parent, args, ctx) => {
    const input = args.input;
    if (!isRecord(input)) throw new Error('createIssue needs an input object');
    const repositoryId = input.repositoryId;
    if (typeof repositoryId !== 'string') throw new Error('createIssue needs repositoryId');
    const decoded = decodeGlobalId(repositoryId);
    if (decoded === null || decoded.kind !== 'repo') throw new Error('createIssue: unknown repository');
    const [owner, name] = decoded.parts;
    if (owner === undefined || name === undefined) throw new Error('createIssue: unknown repository');
    const repo = ctx.forge.getRepo(owner, name);
    if (repo === undefined) throw new Error('createIssue: unknown repository');
    const title = input.title;
    if (typeof title !== 'string' || title === '') throw new Error('createIssue needs a title');
    const issue = createIssueInternal(ctx.forge, repo, title, typeof input.body === 'string' ? input.body : '');
    return { __typename: 'CreateIssuePayload', issue: issueRuntime(repo, issue) };
  },
  closeIssue: (parent, args, ctx) => {
    const input = args.input;
    if (!isRecord(input)) throw new Error('closeIssue needs an input object');
    const issueId = input.issueId;
    if (typeof issueId !== 'string') throw new Error('closeIssue needs issueId');
    const decoded = decodeGlobalId(issueId);
    if (decoded === null || decoded.kind !== 'issue') throw new Error('closeIssue: unknown issue');
    const [owner, name, numberText] = decoded.parts;
    const number = Number(numberText);
    if (owner === undefined || name === undefined || !Number.isInteger(number)) throw new Error('closeIssue: unknown issue');
    const repo = ctx.forge.getRepo(owner, name);
    if (repo === undefined) throw new Error('closeIssue: unknown repository');
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (issue === undefined) throw new Error('closeIssue: unknown issue');
    issue.state = 'closed';
    issue.updatedAt = ctx.forge.nextTsIso();
    touchIssue(issue);
    return { __typename: 'CloseIssuePayload', issue: issueRuntime(repo, issue) };
  },
  createPullRequest: (parent, args, ctx) => {
    const input = args.input;
    if (!isRecord(input)) throw new Error('createPullRequest needs an input object');
    const repositoryId = input.repositoryId;
    if (typeof repositoryId !== 'string') throw new Error('createPullRequest needs repositoryId');
    const decoded = decodeGlobalId(repositoryId);
    if (decoded === null || decoded.kind !== 'repo') throw new Error('createPullRequest: unknown repository');
    const [owner, name] = decoded.parts;
    if (owner === undefined || name === undefined) throw new Error('createPullRequest: unknown repository');
    const repo = ctx.forge.getRepo(owner, name);
    if (repo === undefined) throw new Error('createPullRequest: unknown repository');
    const head = input.headRefName;
    const base = input.baseRefName;
    const title = input.title;
    if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') {
      throw new Error('createPullRequest needs headRefName, baseRefName and title');
    }
    const pull = createPullInternal(ctx.forge, repo, head, base, title, typeof input.body === 'string' ? input.body : '');
    if (pull === null) throw new Error('createPullRequest: head or base branch is missing, or the branches do not differ');
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullRuntime(ctx.forge, repo, pull) };
  },
  mergePullRequest: (parent, args, ctx) => {
    const input = args.input;
    if (!isRecord(input)) throw new Error('mergePullRequest needs an input object');
    const pullRequestId = input.pullRequestId;
    if (typeof pullRequestId !== 'string') throw new Error('mergePullRequest needs pullRequestId');
    const decoded = decodeGlobalId(pullRequestId);
    if (decoded === null || decoded.kind !== 'pr') throw new Error('mergePullRequest: unknown pull request');
    const [owner, name, numberText] = decoded.parts;
    const number = Number(numberText);
    if (owner === undefined || name === undefined || !Number.isInteger(number)) throw new Error('mergePullRequest: unknown pull request');
    const repo = ctx.forge.getRepo(owner, name);
    if (repo === undefined) throw new Error('mergePullRequest: unknown repository');
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) throw new Error('mergePullRequest: unknown pull request');
    if (pull.merged) throw new Error('mergePullRequest: pull request already merged');
    const sha = squashMerge(ctx.forge, repo, pull);
    if (sha === null) throw new Error('mergePullRequest: merge conflict');
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = ctx.forge.nextTsIso();
    pull.mergeCommitSha = sha;
    pull.base.sha = sha;
    pull.updatedAt = ctx.forge.nextTsIso();
    return { __typename: 'MergePullRequestPayload', pullRequest: pullRuntime(ctx.forge, repo, pull) };
  },
  addComment: (parent, args, ctx) => {
    const input = args.input;
    if (!isRecord(input)) throw new Error('addComment needs an input object');
    const subjectId = input.subjectId;
    if (typeof subjectId !== 'string') throw new Error('addComment needs subjectId');
    const decoded = decodeGlobalId(subjectId);
    if (decoded === null || decoded.kind !== 'issue') throw new Error('addComment: unknown subject');
    const [owner, name, numberText] = decoded.parts;
    const number = Number(numberText);
    if (owner === undefined || name === undefined || !Number.isInteger(number)) throw new Error('addComment: unknown subject');
    const repo = ctx.forge.getRepo(owner, name);
    if (repo === undefined) throw new Error('addComment: unknown repository');
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (issue === undefined) throw new Error('addComment: unknown issue');
    const body = input.body;
    if (typeof body !== 'string' || body === '') throw new Error('addComment needs a body');
    const comment: IssueComment = { id: ctx.forge.nextCommentId, body, user: VIEWER_LOGIN, createdAt: ctx.forge.nextTsIso() };
    ctx.forge.nextCommentId += 1;
    issue.comments.push(comment);
    touchIssue(issue);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'CommentEdge',
        node: { __typename: 'Comment', id: commentGlobalId(owner, name, number, comment.id), body: comment.body },
      },
    };
  },
};

/** The resolver table, by runtime type. */
function resolverFor(typeName: string, field: string): GqlResolver | undefined {
  if (typeName === 'Query') return QUERY_RESOLVERS[field];
  if (typeName === 'Mutation') return MUTATION_RESOLVERS[field];
  if (typeName === 'Repository') return REPO_RESOLVERS[field];
  if (typeName === 'PullRequest') return PULL_RESOLVERS[field];
  if (typeName === '__Type') {
    if (field === 'fields') {
      return (parent) => (parent._fields as unknown[]) ?? [];
    }
    if (field === 'enumValues') {
      return (parent) => (parent._enumValues as unknown[] | null) ?? null;
    }
  }
  return undefined;
}

/** Execute a selection set against a runtime object. Returns null on error. */
export function executeSelections(
  parent: GqlRuntime,
  selections: readonly GqlSelection[],
  variables: Record<string, unknown>,
  ctx: GqlContext,
  path: Array<string | number>,
): Record<string, unknown> | null {
  const typeName = parent.__typename;
  const allowed = GQL_SCHEMA_FIELDS[typeName];
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const nested = executeSelections(parent, selection.selections, variables, ctx, path);
      if (nested === null) return null;
      Object.assign(out, nested);
      continue;
    }
    const field = selection;
    if (field.name === '__typename') {
      out[field.alias ?? field.name] = typeName;
      continue;
    }
    if (allowed === undefined || !allowed.includes(field.name)) {
      ctx.errors.push({
        message: `Cannot query field "${field.name}" on type "${typeName}".`,
        path: [...path, field.alias ?? field.name],
      });
      return null;
    }
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = resolveGqlValue(arg.value, variables);
    let value: unknown;
    const resolver = resolverFor(typeName, field.name);
    try {
      value = resolver !== undefined ? resolver(parent, args, ctx) : parent[field.name];
    } catch (err) {
      ctx.errors.push({
        message: err instanceof Error ? err.message : String(err),
        path: [...path, field.alias ?? field.name],
      });
      return null;
    }
    if (value === null || value === undefined) {
      out[field.alias ?? field.name] = null;
      continue;
    }
    if (field.selections === null) {
      out[field.alias ?? field.name] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) {
        if (item !== null && typeof item === 'object' && '__typename' in item) {
          const nested = executeSelections(item as GqlRuntime, field.selections, variables, ctx, [...path, field.alias ?? field.name]);
          if (nested === null) return null;
          items.push(nested);
        } else {
          items.push(item);
        }
      }
      out[field.alias ?? field.name] = items;
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      const nested = executeSelections(value as GqlRuntime, field.selections, variables, ctx, [...path, field.alias ?? field.name]);
      if (nested === null) return null;
      out[field.alias ?? field.name] = nested;
      continue;
    }
    out[field.alias ?? field.name] = value;
  }
  return out;
}

/** Execute one GraphQL operation document. */
export function executeGraphQL(
  forge: Forge,
  document: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: unknown; errors: Array<{ message: string; path?: Array<string | number> }> } {
  const ctx: GqlContext = { forge, errors: [] };
  let operations: GqlOperation[];
  try {
    const parser = new GqlParser(lexGraphQL(document));
    operations = parser.parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation = operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  if (operationName !== undefined) {
    const named = operations.find((candidate) => candidate.name === operationName);
    if (named !== undefined) operation = named;
  }
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const [name, defaultValue] of operation.variables) {
    if (mergedVariables[name] === undefined && defaultValue !== null) {
      mergedVariables[name] = resolveGqlValue(defaultValue, variables);
    }
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlRuntime = { __typename: rootType };
  const data = executeSelections(root, operation.selections, mergedVariables, ctx, []);
  if (ctx.errors.length > 0 || data === null) return { data: null, errors: ctx.errors };
  return { data, errors: [] };
}

/** Handle POST /api/graphql (single operation or a batch array). */
export async function handleGraphQL(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, forge, 400, { data: null, errors: [{ message: 'Bad Request' }] });
  }
  const json = parseJsonBody(body);
  if (json === null) {
    return sendJson(res, forge, 400, { data: null, errors: [{ message: 'Problems parsing JSON' }] });
  }
  if (Array.isArray(json)) {
    const results = json.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        return { data: null, errors: [{ message: 'each batch entry needs a query string' }] };
      }
      const variables = isRecord(entry.variables) ? entry.variables : {};
      const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
      return executeGraphQL(forge, entry.query, variables, operationName);
    });
    return sendJson(res, forge, 200, results);
  }
  if (!isRecord(json) || typeof json.query !== 'string') {
    return sendJson(res, forge, 400, { data: null, errors: [{ message: 'a query string is required' }] });
  }
  const variables = isRecord(json.variables) ? json.variables : {};
  const operationName = typeof json.operationName === 'string' ? json.operationName : undefined;
  const result = executeGraphQL(forge, json.query, variables, operationName);
  const out: Record<string, unknown> = { data: result.data };
  if (result.errors.length > 0) out.errors = result.errors;
  return sendJson(res, forge, 200, out);
}

// ---------------------------------------------------------------- 11. MCP

/** The six tools, in a fixed order, byte-identical on every tools/list. */
export const MCP_TOOLS: ReadonlyArray<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const MCP_TOOL_NAMES = new Set(MCP_TOOLS.map((tool) => String(tool.name)));

/** The required arguments of a tool, from its inputSchema. */
function mcpRequiredArgs(name: string): string[] {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return [];
  const schema = tool.inputSchema as Record<string, unknown> | undefined;
  if (schema === undefined || !Array.isArray(schema.required)) return [];
  return schema.required.filter((entry): entry is string => typeof entry === 'string');
}

/** A tools/call result: text content plus the same object structured. */
function mcpResult(value: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

/** A tools/call failure: isError true with an explanatory text. */
function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The REST-shaped repository object MCP tools return. */
function mcpRepoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

/** The REST-shaped issue object MCP tools return. */
function mcpIssueObject(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: issue.user, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
  };
}

/** Dispatch one tools/call. Answers a result object (never throws). */
export function callMcpTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const missing = mcpRequiredArgs(name).filter((field) => {
    const value = args[field];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) return mcpToolError(`Missing required argument(s): ${missing.join(', ')}`);
  const owner = args.owner;
  const repoName = args.repo;
  if (name === 'create_repo') {
    const repoNameArg = args.name;
    if (typeof repoNameArg !== 'string' || repoNameArg === '') return mcpToolError('Missing required argument(s): name');
    const repo = forge.createRepo(
      repoNameArg,
      typeof args.private === 'boolean' ? args.private : false,
      typeof args.description === 'string' ? args.description : '',
    );
    if (repo === null) return mcpToolError(`Repository ${repoNameArg} already exists`);
    return mcpResult(mcpRepoObject(repo));
  }
  if (typeof owner !== 'string' || typeof repoName !== 'string') {
    return mcpToolError('Missing required argument(s): owner, repo');
  }
  const repo = forge.getRepo(owner, repoName);
  if (name === 'get_repo') {
    if (repo === undefined) return mcpToolError(`Repository ${owner}/${repoName} not found`);
    return mcpResult(mcpRepoObject(repo));
  }
  if (name === 'create_issue') {
    if (repo === undefined) return mcpToolError(`Repository ${owner}/${repoName} not found`);
    const title = args.title;
    if (typeof title !== 'string' || title === '') return mcpToolError('Missing required argument(s): title');
    const issue = createIssueInternal(forge, repo, title, typeof args.body === 'string' ? args.body : '');
    return mcpResult(mcpIssueObject(issue));
  }
  if (name === 'list_issues') {
    if (repo === undefined) return mcpToolError(`Repository ${owner}/${repoName} not found`);
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    let listed = [...repo.issues];
    if (state === 'open') listed = listed.filter((issue) => issue.state === 'open');
    else if (state === 'closed') listed = listed.filter((issue) => issue.state === 'closed');
    listed.sort((a, b) => a.number - b.number);
    return mcpResult({ issues: listed.map((issue) => mcpIssueObject(issue)) });
  }
  if (name === 'create_pull_request') {
    if (repo === undefined) return mcpToolError(`Repository ${owner}/${repoName} not found`);
    const head = args.head;
    const base = args.base;
    const title = args.title;
    if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') {
      return mcpToolError('Missing required argument(s): head, base, title');
    }
    const pull = createPullInternal(forge, repo, head, base, title, typeof args.body === 'string' ? args.body : '');
    if (pull === null) return mcpToolError('head or base branch is missing, or the branches do not differ');
    return mcpResult({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: 'open',
      head: { ref: pull.head.ref, sha: pull.head.sha },
      base: { ref: pull.base.ref, sha: pull.base.sha },
    });
  }
  if (name === 'merge_pull_request') {
    if (repo === undefined) return mcpToolError(`Repository ${owner}/${repoName} not found`);
    const rawNumber = args.pull_number;
    const number = typeof rawNumber === 'number' ? rawNumber : Number(rawNumber);
    if (!Number.isInteger(number)) return mcpToolError('Missing required argument(s): pull_number');
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) return mcpToolError(`Pull request #${number} not found`);
    if (pull.merged) return mcpToolError(`Pull request #${number} is already merged`);
    const sha = squashMerge(forge, repo, pull);
    if (sha === null) return mcpToolError(`Pull request #${number} has a merge conflict`);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = forge.nextTsIso();
    pull.mergeCommitSha = sha;
    pull.base.sha = sha;
    pull.updatedAt = forge.nextTsIso();
    return mcpResult({ id: pull.id, number: pull.number, merged: true, state: 'closed', sha });
  }
  return mcpToolError(`Unknown tool: ${name}`);
}

/** Send a JSON-RPC response (result or error) for /mcp. */
function sendJsonRpc(
  res: ServerResponse,
  forge: Forge,
  status: number,
  id: unknown,
  result: unknown,
  error?: { code: number; message: string },
): void {
  const body: Record<string, unknown> = { jsonrpc: '2.0', id: id ?? null };
  if (error !== undefined) body.error = error;
  else body.result = result;
  sendBuffer(res, forge, status, Buffer.from(JSON.stringify(body), 'utf8'), 'application/json');
}

/** Handle POST /mcp: parse, authenticate, dispatch. */
export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    return sendJsonRpc(res, forge, 400, null, undefined, { code: -32700, message: 'Parse error' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return sendJsonRpc(res, forge, 400, null, undefined, { code: -32700, message: 'Parse error' });
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    return sendJsonRpc(res, forge, 200, isRecord(parsed) ? parsed.id : null, undefined, {
      code: -32600,
      message: 'Invalid Request',
    });
  }
  const id = parsed.id;
  if (!forge.checkAuth(req)) {
    return sendJsonRpc(res, forge, 401, id ?? null, undefined, { code: -32001, message: 'Unauthorized' });
  }
  // A notification (no id) is answered 202 with an empty body.
  if (id === undefined) {
    res.writeHead(202, { 'x-github-request-id': forge.nextRequestId() });
    res.end();
    return;
  }
  const params = isRecord(parsed.params) ? parsed.params : {};
  const method = parsed.method;
  if (method === 'server/discover') {
    return sendJsonRpc(res, forge, 200, id, {
      resultType: 'discover',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-forge', version: FORGE_VERSION },
      instructions: 'A GitHub-compatible forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone-forge', version: FORGE_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = params.protocolVersion;
    const protocolVersion =
      typeof requested === 'string' && ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(requested)
        ? requested
        : '2026-07-28';
    return sendJsonRpc(res, forge, 200, id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-forge', version: FORGE_VERSION },
    });
  }
  if (method === 'tools/list') {
    return sendJsonRpc(res, forge, 200, id, { tools: MCP_TOOLS });
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (typeof name !== 'string' || !MCP_TOOL_NAMES.has(name)) {
      return sendJsonRpc(res, forge, 200, id, undefined, { code: -32602, message: `Unknown tool: ${String(name)}` });
    }
    const result = callMcpTool(forge, name, args);
    return sendJsonRpc(res, forge, 200, id, result);
  }
  if (method === 'ping') {
    return sendJsonRpc(res, forge, 200, id, {});
  }
  return sendJsonRpc(res, forge, 200, id, undefined, { code: -32601, message: `Method not found: ${method}` });
}

// ---------------------------------------------------------------- router

/** Split a pathname into decoded segments. */
function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** Route one request. Never throws: a handler failure becomes a 500. */
export async function handleRequest(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://forge');
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    const segments = pathSegments(pathname);
    const method = req.method ?? 'GET';

    // GET /healthz — the boot check: fast, unauthenticated, static.
    if (segments.length === 1 && segments[0] === 'healthz' && method === 'GET') {
      return sendBuffer(res, forge, 200, Buffer.from('{"ok":true}', 'utf8'), 'application/json');
    }

    // POST /mcp — authenticates inside (it must parse first, for -32700).
    if (segments.length === 1 && segments[0] === 'mcp' && method === 'POST') {
      return handleMcp(forge, req, res);
    }

    // POST /api/graphql
    if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql' && method === 'POST') {
      if (!forge.checkAuth(req)) {
        return sendJson(res, forge, 401, { data: null, errors: [{ message: 'Requires authentication' }] });
      }
      return handleGraphQL(forge, req, res);
    }

    // /api/v3/...
    if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
      if (!forge.checkAuth(req)) return sendError(res, forge, 401, 'Requires authentication');
      return handleRest({ forge, req, res, segments: segments.slice(2), query: url.searchParams });
    }

    // /{owner}/{repo}.git/...
    if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
      const owner = segments[0]!;
      const repoName = segments[1]!.slice(0, -'.git'.length);
      const tail = segments.slice(2);
      if (!forge.checkAuth(req)) return sendError(res, forge, 401, 'Requires authentication');
      if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
        return handleGitInfoRefs(forge, req, res, owner, repoName, url.searchParams);
      }
      if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
        return handleGitUploadPack(forge, req, res, owner, repoName);
      }
      if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
        return handleGitReceivePack(forge, req, res, owner, repoName);
      }
      return sendError(res, forge, 404, 'Not Found');
    }

    return sendError(res, forge, 404, 'Not Found');
  } catch (err) {
    try {
      sendError(res, forge, 500, err instanceof Error ? err.message : 'Internal Server Error');
    } catch {
      // The socket is already gone; nothing left to answer.
    }
  }
}

/** Build the forge's HTTP server (not yet listening). */
export function createForgeServer(forge: Forge): Server {
  const server = createServer((req, res) => {
    void handleRequest(forge, req, res);
  });
  return server;
}
