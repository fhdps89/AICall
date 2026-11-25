/**
 * Safe error classification and sanitization for morning lecture audio generation / rebuild.
 * Never copies raw error messages, URLs, API keys, or secrets into output fields.
 */

export const AUDIO_ERROR_STAGES = [
  'script',
  'tts',
  'fit',
  'encode',
  'save',
  'rebuild_timeout',
  'unknown',
] as const;
export type AudioErrorStage = (typeof AUDIO_ERROR_STAGES)[number];

export const AUDIO_ERROR_CODES = [
  'QUOTA',
  'QUOTA_DAILY',
  'MODEL_NOT_FOUND',
  'AUTH',
  'BAD_REQUEST',
  'UNAVAILABLE',
  'STEP_TIMEOUT',
  'REBUILD_TIMEOUT',
  'NO_AUDIO',
  'FIT_NO_CONVERGE',
  'DISK',
  'NETWORK',
  'UNKNOWN',
] as const;
export type AudioErrorCode = (typeof AUDIO_ERROR_CODES)[number];

export const GOOGLE_RPC_STATUSES = [
  'RESOURCE_EXHAUSTED',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'INVALID_ARGUMENT',
  'UNAVAILABLE',
  'INTERNAL',
  'DEADLINE_EXCEEDED',
] as const;
export type GoogleRpcStatus = (typeof GOOGLE_RPC_STATUSES)[number];

export const AUDIO_BACKUP_RESULTS = [
  'ok',
  'denied',
  'too_large',
  'timeout',
  'network',
  'http_error',
  'no_file',
  'not_current',
] as const;
export type AudioBackupResultKind = (typeof AUDIO_BACKUP_RESULTS)[number];

export interface LectureAudioError {
  stage: AudioErrorStage;
  code: AudioErrorCode;
  httpStatus: number | null;
  googleStatus: GoogleRpcStatus | null;
  quota: 'minute' | 'day' | null;
  retryDelaySec: number | null;
  attempts: number;
  completed: number;
  total: number;
  at: string;
  origin: 'local' | 'backup';
}

export interface AudioBackupResult {
  target: 'firestore';
  result: AudioBackupResultKind;
  httpStatus: number | null;
  chunks: number | null;
  bytes: number | null;
  at: string;
}

export interface ClassifyAudioErrorContext {
  stage?: AudioErrorStage;
  attempts?: number;
  completed?: number;
  total?: number;
  at?: string;
  origin?: 'local' | 'backup';
}

const STAGE_SET = new Set<string>(AUDIO_ERROR_STAGES);
const CODE_SET = new Set<string>(AUDIO_ERROR_CODES);
const GOOGLE_STATUS_SET = new Set<string>(GOOGLE_RPC_STATUSES);
const BACKUP_RESULT_SET = new Set<string>(AUDIO_BACKUP_RESULTS);

const DISK_ERR_CODES = new Set(['ENOSPC', 'EACCES', 'EROFS', 'EIO']);
const NETWORK_ERR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export const AUDIO_CHUNK_MAX = 8;

export const AUDIO_COOLDOWN_DEFAULT_MS = 30 * 60 * 1000;
export const AUDIO_COOLDOWN_LONG_MS = 6 * 60 * 60 * 1000;

function validHttpStatus(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599 ? v : null;
}

function validNonNegInt(v: unknown, max = 10_000): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(max, Math.trunc(v)));
}

function validRetryDelaySec(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(3600, Math.ceil(v)));
}

function validIsoAt(v: unknown, fallback?: string): string {
  if (typeof v === 'string' && v.length <= 40) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  if (fallback) return fallback;
  return new Date().toISOString();
}

function extractMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as any).message === 'string') {
    return (err as any).message;
  }
  return '';
}

function extractSysCode(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const obj = err as any;
  if (typeof obj.code === 'string') return obj.code;
  if (obj.cause && typeof obj.cause === 'object' && typeof obj.cause.code === 'string') {
    return obj.cause.code;
  }
  return '';
}

function extractGoogleStatus(err: unknown, msg: string): GoogleRpcStatus | null {
  if (err && typeof err === 'object') {
    const g = (err as any).googleStatus;
    if (typeof g === 'string' && GOOGLE_STATUS_SET.has(g)) return g as GoogleRpcStatus;
  }
  const m =
    /\b(RESOURCE_EXHAUSTED|NOT_FOUND|PERMISSION_DENIED|UNAUTHENTICATED|INVALID_ARGUMENT|UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED)\b/.exec(
      msg
    );
  return m ? (m[1] as GoogleRpcStatus) : null;
}

function extractRetryDelaySec(err: unknown, msg: string): number | null {
  if (err && typeof err === 'object' && (err as any).retryDelaySec !== undefined) {
    const d = validRetryDelaySec((err as any).retryDelaySec);
    if (d !== null) return d;
  }
  const m =
    /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i.exec(msg) ||
    /\bretryDelay\s*[:=]\s*["']?(\d+(?:\.\d+)?)s/i.exec(msg);
  if (!m) return null;
  const parsed = Number(m[1]);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(3600, Math.ceil(parsed))) : null;
}

export function classifyLectureAudioError(
  err: unknown,
  ctx: ClassifyAudioErrorContext = {}
): LectureAudioError {
  const obj = err && typeof err === 'object' ? (err as any) : {};
  const msg = extractMessage(err);
  const sysCode = extractSysCode(err);

  let stage: AudioErrorStage =
    typeof obj.stage === 'string' && STAGE_SET.has(obj.stage)
      ? (obj.stage as AudioErrorStage)
      : ctx.stage && STAGE_SET.has(ctx.stage)
      ? ctx.stage
      : 'unknown';

  const httpStatus = validHttpStatus(obj.status) ?? validHttpStatus(obj.httpStatus);
  const googleStatus = extractGoogleStatus(err, msg);
  const retryDelaySec = extractRetryDelaySec(err, msg);
  const attempts = validNonNegInt(obj.attempts ?? ctx.attempts ?? 0, 3);
  const completed = validNonNegInt(obj.completed ?? ctx.completed ?? 0);
  const total = validNonNegInt(obj.total ?? ctx.total ?? 0);
  const at = validIsoAt(ctx.at);
  const origin: 'local' | 'backup' = ctx.origin === 'backup' ? 'backup' : 'local';

  let code: AudioErrorCode = 'UNKNOWN';
  let quota: 'minute' | 'day' | null = null;

  if (/^audio rebuild timed out/.test(msg)) {
    code = 'REBUILD_TIMEOUT';
    stage = 'rebuild_timeout';
  } else if (/^lecture job timed out/.test(msg)) {
    code = 'REBUILD_TIMEOUT';
  } else if (/^lecture (?:TTS|script) timed out/.test(msg) || obj.name === 'TimeoutError') {
    code = 'STEP_TIMEOUT';
  } else if (/TTS 음성 데이터 없음/.test(msg)) {
    code = 'NO_AUDIO';
  } else if (/duration fit did not converge/.test(msg)) {
    code = 'FIT_NO_CONVERGE';
  } else if (DISK_ERR_CODES.has(sysCode)) {
    code = 'DISK';
  } else if (httpStatus === 429 || googleStatus === 'RESOURCE_EXHAUSTED') {
    if (/PerDay/.test(msg)) {
      code = 'QUOTA_DAILY';
      quota = 'day';
    } else {
      code = 'QUOTA';
      quota = 'minute';
    }
  } else if (httpStatus === 404 || googleStatus === 'NOT_FOUND') {
    code = 'MODEL_NOT_FOUND';
  } else if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    googleStatus === 'PERMISSION_DENIED' ||
    googleStatus === 'UNAUTHENTICATED' ||
    /API_KEY_INVALID|API key not valid/i.test(msg)
  ) {
    code = 'AUTH';
  } else if (httpStatus === 400 || googleStatus === 'INVALID_ARGUMENT') {
    code = 'BAD_REQUEST';
  } else if (
    (httpStatus !== null && httpStatus >= 500 && httpStatus <= 599) ||
    googleStatus === 'UNAVAILABLE' ||
    googleStatus === 'INTERNAL' ||
    googleStatus === 'DEADLINE_EXCEEDED'
  ) {
    code = 'UNAVAILABLE';
  } else if (/fetch failed/i.test(msg) || NETWORK_ERR_CODES.has(sysCode)) {
    code = 'NETWORK';
  }

  return {
    stage,
    code,
    httpStatus,
    googleStatus,
    quota,
    retryDelaySec,
    attempts,
    completed,
    total,
    at,
    origin,
  };
}

export function sanitizeAudioError(raw: unknown): LectureAudioError | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.code !== 'string' || !CODE_SET.has(r.code)) return undefined;
  const stage: AudioErrorStage =
    typeof r.stage === 'string' && STAGE_SET.has(r.stage) ? (r.stage as AudioErrorStage) : 'unknown';
  const code = r.code as AudioErrorCode;
  const httpStatus = validHttpStatus(r.httpStatus);
  const googleStatus =
    typeof r.googleStatus === 'string' && GOOGLE_STATUS_SET.has(r.googleStatus)
      ? (r.googleStatus as GoogleRpcStatus)
      : null;
  const quota: 'minute' | 'day' | null =
    r.quota === 'minute' || r.quota === 'day' ? r.quota : null;
  const retryDelaySec = validRetryDelaySec(r.retryDelaySec);
  const attempts = validNonNegInt(r.attempts, 3);
  const completed = validNonNegInt(r.completed);
  const total = validNonNegInt(r.total);
  const at = validIsoAt(r.at);
  const origin: 'local' | 'backup' = r.origin === 'backup' ? 'backup' : 'local';

  return {
    stage,
    code,
    httpStatus,
    googleStatus,
    quota,
    retryDelaySec,
    attempts,
    completed,
    total,
    at,
    origin,
  };
}

export function sanitizeAudioBackupResult(raw: unknown): AudioBackupResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.target !== 'firestore') return undefined;
  if (typeof r.result !== 'string' || !BACKUP_RESULT_SET.has(r.result)) return undefined;
  const httpStatus = validHttpStatus(r.httpStatus);
  const chunks =
    typeof r.chunks === 'number' && Number.isInteger(r.chunks) && r.chunks >= 0 && r.chunks <= 1000
      ? r.chunks
      : null;
  const bytes =
    typeof r.bytes === 'number' && Number.isInteger(r.bytes) && r.bytes >= 0 && r.bytes <= 100_000_000
      ? r.bytes
      : null;
  const at = validIsoAt(r.at);
  return {
    target: 'firestore',
    result: r.result as AudioBackupResultKind,
    httpStatus,
    chunks,
    bytes,
    at,
  };
}

export function cooldownMsFor(code: AudioErrorCode): number {
  if (
    code === 'QUOTA_DAILY' ||
    code === 'AUTH' ||
    code === 'MODEL_NOT_FOUND' ||
    code === 'BAD_REQUEST'
  ) {
    return AUDIO_COOLDOWN_LONG_MS;
  }
  return AUDIO_COOLDOWN_DEFAULT_MS;
}

export function retryableFor(code: AudioErrorCode): boolean {
  return (
    code !== 'AUTH' &&
    code !== 'MODEL_NOT_FOUND' &&
    code !== 'BAD_REQUEST' &&
    code !== 'QUOTA_DAILY'
  );
}
