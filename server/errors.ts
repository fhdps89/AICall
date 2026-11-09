/**
 * Standard API error replies. Responses carry a fixed Korean sentence for the user and a short
 * code; the real error (message, stack, upstream reply) goes to the server log only.
 */
import type { Response } from 'express';

export const NO_KEY_MESSAGE = '서버에 Gemini 키가 없어요. 앱 설정 → Gemini 키에서 키를 저장해 주세요.';

export type ApiErrorCode =
  | 'NO_SERVER_KEY'
  | 'BAD_REQUEST'
  | 'TTS_FAILED'
  | 'TRANSCRIBE_FAILED'
  | 'REVIEW_FAILED'
  | 'QUIZ_FAILED'
  | 'COACH_FAILED'
  | 'LECTURE_FAILED'
  | 'KEEP_PARSE_FAILED'
  | 'STT_BENCH_FAILED'
  | 'UPLOAD_FAILED'
  | 'TOKEN_FAILED';

export function apiError(res: Response, status: number, code: ApiErrorCode, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ ok: false, code, error: message, ...extra });
}

export function noKey(res: Response): void {
  apiError(res, 503, 'NO_SERVER_KEY', NO_KEY_MESSAGE);
}
