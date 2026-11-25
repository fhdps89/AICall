/**
 * Single gate for morning lecture generation cost controls:
 * - Per-date lease lock (in-process + remote Firestore CAS)
 * - Daily generation cap (default 2, refund when billable Gemini calls === 0)
 * - Immediate cooldown on non-retryable errors (429/AUTH/etc.)
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  AUDIO_ERROR_CODES,
  cooldownMsFor,
  retryableFor,
  type AudioErrorCode,
} from './lectureAudioError.ts';

export const LECTURE_DAILY_GEN_CAP_DEFAULT = 2;
export const GEN_LEASE_MARGIN_MS = 60_000;
export const LECTURE_GEN_INSTANCE_ID = crypto.randomUUID();

export type GenKind = 'job' | 'rebuild';
export type GenSkipReason = 'daily_cap' | 'lease' | 'cooldown';

export interface GenLease {
  owner: string;
  token: string;
  kind: GenKind;
  until: string;
}

export interface GenControl {
  genCount: number;
  lease?: GenLease;
  cooldownUntil?: string;
  cooldownCode?: AudioErrorCode;
}

export interface GenSkip {
  reason: GenSkipReason;
  at: string;
  until: string | null;
}

export interface GenAcquireReq {
  owner: string;
  token: string;
  kind: GenKind;
  ttlMs: number;
  cap: number;
  now: number;
  ignoreCooldown: boolean;
}

export interface GenReleaseReq {
  token: string;
  refund: boolean;
  cooldownUntil?: string;
  cooldownCode?: AudioErrorCode;
  success: boolean;
}

export interface GenRemote {
  acquire(
    date: string,
    req: GenAcquireReq
  ): Promise<
    | { ok: true; gc: GenControl }
    | { ok: false; skip: GenSkip; gc: GenControl }
    | { ok: 'unavailable' }
  >;
  release(date: string, rel: GenReleaseReq): Promise<void>;
}

export interface GenSlot {
  token: string;
  billable: { calls: number };
  release(o: { success: boolean; code?: AudioErrorCode; now?: number }): Promise<void>;
}

export interface GenDiag {
  dailyGenCount: number;
  dailyGenCap: number;
  genSkipReason: GenSkipReason | null;
  genSkipAt: string | null;
  genBlockedUntil: string | null;
  genLeaseMode: 'firestore' | 'local' | null;
}

interface LocalGenFile extends GenControl {
  lastSkip?: GenSkip;
  leaseMode?: 'firestore' | 'local';
}

const CODE_SET = new Set<string>(AUDIO_ERROR_CODES);
const SKIP_REASON_SET = new Set<string>(['daily_cap', 'lease', 'cooldown']);
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

function validIso(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 40) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function nextMidnightKstIso(now: number): string {
  const kstMs = now + 9 * 3_600_000;
  const nextKstMidnightMs = (Math.floor(kstMs / 86_400_000) + 1) * 86_400_000;
  return new Date(nextKstMidnightMs - 9 * 3_600_000).toISOString();
}

export function lectureDailyGenCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env?.LECTURE_DAILY_GEN_CAP;
  if (typeof raw !== 'string') return LECTURE_DAILY_GEN_CAP_DEFAULT;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return LECTURE_DAILY_GEN_CAP_DEFAULT;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : LECTURE_DAILY_GEN_CAP_DEFAULT;
}

export function sanitizeGenControl(raw: unknown): GenControl {
  if (!raw || typeof raw !== 'object') return { genCount: 0 };
  const r = raw as Record<string, unknown>;
  const genCount =
    typeof r.genCount === 'number' && Number.isFinite(r.genCount)
      ? Math.max(0, Math.min(100, Math.trunc(r.genCount)))
      : 0;

  let lease: GenLease | undefined;
  if (r.lease && typeof r.lease === 'object') {
    const l = r.lease as Record<string, unknown>;
    const owner = typeof l.owner === 'string' && SAFE_ID_RE.test(l.owner) ? l.owner : undefined;
    const token = typeof l.token === 'string' && SAFE_ID_RE.test(l.token) ? l.token : undefined;
    const kind: GenKind | undefined = l.kind === 'job' || l.kind === 'rebuild' ? l.kind : undefined;
    const until = validIso(l.until);
    if (owner && token && kind && until) {
      lease = { owner, token, kind, until };
    }
  }

  const cooldownUntil = validIso(r.cooldownUntil);
  const cooldownCode =
    typeof r.cooldownCode === 'string' && CODE_SET.has(r.cooldownCode)
      ? (r.cooldownCode as AudioErrorCode)
      : undefined;

  return {
    genCount,
    ...(lease ? { lease } : {}),
    ...(cooldownUntil ? { cooldownUntil } : {}),
    ...(cooldownUntil && cooldownCode ? { cooldownCode } : {}),
  };
}

export function decideGenAcquire(
  gc: GenControl,
  req: GenAcquireReq
): { ok: true; next: GenControl } | { ok: false; skip: GenSkip } {
  const at = new Date(req.now).toISOString();

  if (gc.lease && gc.lease.owner !== req.owner) {
    const leaseUntilMs = Date.parse(gc.lease.until);
    if (Number.isFinite(leaseUntilMs) && leaseUntilMs > req.now) {
      return {
        ok: false,
        skip: {
          reason: 'lease',
          at,
          until: new Date(leaseUntilMs).toISOString(),
        },
      };
    }
  }

  if (!req.ignoreCooldown && gc.cooldownUntil) {
    const cdMs = Date.parse(gc.cooldownUntil);
    if (Number.isFinite(cdMs) && cdMs > req.now) {
      return {
        ok: false,
        skip: {
          reason: 'cooldown',
          at,
          until: new Date(cdMs).toISOString(),
        },
      };
    }
  }

  if (gc.genCount >= req.cap) {
    return {
      ok: false,
      skip: {
        reason: 'daily_cap',
        at,
        until: nextMidnightKstIso(req.now),
      },
    };
  }

  const next: GenControl = {
    ...gc,
    genCount: gc.genCount + 1,
    lease: {
      owner: req.owner,
      token: req.token,
      kind: req.kind,
      until: new Date(req.now + req.ttlMs).toISOString(),
    },
  };
  return { ok: true, next };
}

export function applyGenRelease(gc: GenControl, rel: GenReleaseReq): GenControl {
  const next: GenControl = { ...gc };
  if (rel.refund) {
    next.genCount = Math.max(0, next.genCount - 1);
  }
  if (rel.success) {
    delete next.cooldownUntil;
    delete next.cooldownCode;
  } else if (rel.cooldownUntil) {
    next.cooldownUntil = rel.cooldownUntil;
    if (rel.cooldownCode) next.cooldownCode = rel.cooldownCode;
    else delete next.cooldownCode;
  }
  if (next.lease?.token === rel.token) {
    delete next.lease;
  }
  return next;
}

function genFilePath(dir: string, date: string): string {
  return path.join(dir, `${date}.gen.json`);
}

function sanitizeLastSkip(raw: unknown): GenSkip | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.reason !== 'string' || !SKIP_REASON_SET.has(r.reason)) return undefined;
  const at = validIso(r.at);
  if (!at) return undefined;
  const until = r.until === null ? null : validIso(r.until) ?? null;
  return { reason: r.reason as GenSkipReason, at, until };
}

function readLocalGenFile(dir: string, date: string): LocalGenFile {
  try {
    const raw = JSON.parse(fs.readFileSync(genFilePath(dir, date), 'utf8')) as Record<string, unknown>;
    const gc = sanitizeGenControl(raw);
    const lastSkip = sanitizeLastSkip(raw?.lastSkip);
    const leaseMode = raw?.leaseMode === 'firestore' || raw?.leaseMode === 'local' ? raw.leaseMode : undefined;
    return {
      ...gc,
      ...(lastSkip ? { lastSkip } : {}),
      ...(leaseMode ? { leaseMode } : {}),
    };
  } catch {
    return { genCount: 0 };
  }
}

function writeLocalGenFile(dir: string, date: string, data: LocalGenFile): void {
  fs.mkdirSync(dir, { recursive: true });
  const target = genFilePath(dir, date);
  const tmp = `${target}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** A previous process's in-process lease cannot outlive that process. */
function dropDeadLocalLease(local: LocalGenFile): LocalGenFile {
  if (local.leaseMode !== 'local') return local;
  const leaseStale = Boolean(local.lease && local.lease.owner !== LECTURE_GEN_INSTANCE_ID);
  const skipStale = local.lastSkip?.reason === 'lease';
  if (!leaseStale && !skipStale) return local;
  const next: LocalGenFile = { ...local };
  if (leaseStale) delete next.lease;
  if (skipStale) delete next.lastSkip;
  return next;
}

export function peekGenGate(
  dir: string,
  date: string,
  now = Date.now(),
  opts: { ignoreCooldown?: boolean } = {}
): GenSkip | null {
  const local = dropDeadLocalLease(readLocalGenFile(dir, date));
  if (local.lastSkip?.reason === 'lease' && local.lastSkip.until) {
    const untilMs = Date.parse(local.lastSkip.until);
    if (Number.isFinite(untilMs) && untilMs > now) {
      return local.lastSkip;
    }
  }
  const d = decideGenAcquire(sanitizeGenControl(local), {
    owner: LECTURE_GEN_INSTANCE_ID,
    token: 'peek',
    kind: 'job',
    ttlMs: 0,
    cap: lectureDailyGenCap(),
    now,
    ignoreCooldown: Boolean(opts.ignoreCooldown),
  });
  return d.ok ? null : d.skip;
}

function makeSlot(
  dir: string,
  date: string,
  token: string,
  remote?: GenRemote | null
): GenSlot {
  const billable = { calls: 0 };
  let released = false;
  const slot: GenSlot = {
    token,
    billable,
    release: async (o: { success: boolean; code?: AudioErrorCode; now?: number }) => {
      if (released) return;
      released = true;
      const relNow = o.now ?? Date.now();
      const refund = slot.billable.calls === 0;
      const cooldownUntil =
        !o.success && o.code && !retryableFor(o.code)
          ? new Date(relNow + cooldownMsFor(o.code)).toISOString()
          : undefined;
      const rel: GenReleaseReq = {
        token,
        refund,
        success: o.success,
        ...(cooldownUntil ? { cooldownUntil, cooldownCode: o.code } : {}),
      };

      const cur = readLocalGenFile(dir, date);
      const nextGc = applyGenRelease(sanitizeGenControl(cur), rel);
      const nextLocal: LocalGenFile = {
        ...nextGc,
        ...(cur.leaseMode ? { leaseMode: cur.leaseMode } : {}),
      };
      writeLocalGenFile(dir, date, nextLocal);

      if (remote) {
        try {
          await remote.release(date, rel);
        } catch (err: any) {
          console.warn('[lecture] remote gen release failed:', err?.name || 'error');
        }
      }
    },
  };
  return slot;
}

export function acquireGenSlotSync(
  dir: string,
  date: string,
  opts: {
    kind: GenKind;
    ttlMs: number;
    now?: number;
    ignoreCooldown?: boolean;
  }
): { ok: true; slot: GenSlot } | { ok: false; skip: GenSkip } {
  const now = opts.now ?? Date.now();
  const cap = lectureDailyGenCap();
  const token = crypto.randomUUID();
  const req: GenAcquireReq = {
    owner: LECTURE_GEN_INSTANCE_ID,
    token,
    kind: opts.kind,
    ttlMs: opts.ttlMs,
    cap,
    now,
    ignoreCooldown: Boolean(opts.ignoreCooldown),
  };

  const local = dropDeadLocalLease(readLocalGenFile(dir, date));
  const localGc = sanitizeGenControl(local);
  const d = decideGenAcquire(localGc, req);
  if (!d.ok) {
    writeLocalGenFile(dir, date, {
      ...localGc,
      ...(local.leaseMode ? { leaseMode: local.leaseMode } : {}),
      lastSkip: d.skip,
    });
    return { ok: false, skip: d.skip };
  }

  writeLocalGenFile(dir, date, {
    ...d.next,
    leaseMode: 'local',
  });
  return { ok: true, slot: makeSlot(dir, date, token) };
}

export async function acquireGenSlot(
  dir: string,
  date: string,
  opts: {
    kind: GenKind;
    ttlMs: number;
    now?: number;
    ignoreCooldown?: boolean;
    remote?: GenRemote | null;
  }
): Promise<{ ok: true; slot: GenSlot } | { ok: false; skip: GenSkip }> {
  const now = opts.now ?? Date.now();
  const cap = lectureDailyGenCap();
  const token = crypto.randomUUID();
  const req: GenAcquireReq = {
    owner: LECTURE_GEN_INSTANCE_ID,
    token,
    kind: opts.kind,
    ttlMs: opts.ttlMs,
    cap,
    now,
    ignoreCooldown: Boolean(opts.ignoreCooldown),
  };

  const local = dropDeadLocalLease(readLocalGenFile(dir, date));
  const localGc = sanitizeGenControl(local);
  const d = decideGenAcquire(localGc, req);
  if (!d.ok) {
    writeLocalGenFile(dir, date, {
      ...localGc,
      ...(local.leaseMode ? { leaseMode: local.leaseMode } : {}),
      lastSkip: d.skip,
    });
    return { ok: false, skip: d.skip };
  }

  let leaseMode: 'firestore' | 'local' = 'local';
  let remoteGc: GenControl | undefined;
  if (opts.remote) {
    let r: Awaited<ReturnType<GenRemote['acquire']>>;
    try {
      r = await opts.remote.acquire(date, req);
    } catch (err: any) {
      console.warn('[lecture] remote gen acquire failed:', err?.name || 'error');
      r = { ok: 'unavailable' };
    }
    if (r.ok === false) {
      const mergedCooldownUntil = r.gc.cooldownUntil ?? localGc.cooldownUntil;
      const mergedCooldownCode = r.gc.cooldownUntil ? r.gc.cooldownCode : localGc.cooldownCode;
      writeLocalGenFile(dir, date, {
        ...localGc,
        genCount: Math.max(localGc.genCount, r.gc.genCount),
        ...(mergedCooldownUntil ? { cooldownUntil: mergedCooldownUntil } : {}),
        ...(mergedCooldownUntil && mergedCooldownCode ? { cooldownCode: mergedCooldownCode } : {}),
        leaseMode: 'firestore',
        lastSkip: r.skip,
      });
      return { ok: false, skip: r.skip };
    }
    if (r.ok === true) {
      leaseMode = 'firestore';
      remoteGc = r.gc;
    }
  }

  const local2 = dropDeadLocalLease(readLocalGenFile(dir, date));
  const local2Gc = sanitizeGenControl(local2);
  const d2 = decideGenAcquire(local2Gc, req);
  if (!d2.ok) {
    writeLocalGenFile(dir, date, {
      ...local2Gc,
      leaseMode,
      lastSkip: d2.skip,
    });
    if (remoteGc && opts.remote) {
      try {
        await opts.remote.release(date, { token, refund: true, success: false });
      } catch (err: any) {
        console.warn('[lecture] remote gen release failed:', err?.name || 'error');
      }
    }
    return { ok: false, skip: d2.skip };
  }

  const nextState: LocalGenFile = {
    ...d2.next,
    genCount: Math.max(d2.next.genCount, remoteGc?.genCount ?? 0),
    leaseMode,
  };
  writeLocalGenFile(dir, date, nextState);

  return { ok: true, slot: makeSlot(dir, date, token, opts.remote) };
}

export function readGenDiag(dir: string, date: string, now = Date.now()): GenDiag {
  const local = readLocalGenFile(dir, date);
  const dailyGenCap = lectureDailyGenCap();
  const activeSkip = peekGenGate(dir, date, now, { ignoreCooldown: false });

  let genSkipReason: GenSkipReason | null = null;
  let genSkipAt: string | null = null;
  let genBlockedUntil: string | null = null;

  if (activeSkip) {
    genSkipReason = activeSkip.reason;
    genSkipAt =
      local.lastSkip && local.lastSkip.reason === activeSkip.reason
        ? local.lastSkip.at
        : activeSkip.at;
    genBlockedUntil = activeSkip.until;
  }

  return {
    dailyGenCount: local.genCount,
    dailyGenCap,
    genSkipReason,
    genSkipAt,
    genBlockedUntil,
    genLeaseMode: local.leaseMode ?? null,
  };
}
