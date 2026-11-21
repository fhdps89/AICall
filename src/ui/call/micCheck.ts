export type MicFailReason =
  | "unsupported"
  | "denied"
  | "not_found"
  | "in_use"
  | "timeout"
  | "unknown";

export type GetUserMediaFn = (
  constraints: MediaStreamConstraints
) => Promise<MediaStream>;

export type MicCheckResult =
  | { ok: true; stream: MediaStream }
  | { ok: false; reason: MicFailReason; message: string };

export const MIC_FAIL_MESSAGES: Record<MicFailReason, string> = {
  unsupported:
    "이 브라우저나 기기에서는 마이크 기능을 지원하지 않아요. 다른 브라우저를 쓰거나, 마이크 없이 글로 답하며 진행할 수 있어요.",
  denied:
    "마이크 권한이 꺼져 있어요. 브라우저 주소창 옆 권한 설정에서 마이크를 허용한 뒤 다시 점검하거나, 마이크 없이 글로 답하며 진행할 수 있어요.",
  not_found:
    "연결된 마이크를 찾지 못했어요. 마이크·이어폰 연결을 확인하고 다시 점검하거나, 마이크 없이 글로 답하며 진행할 수 있어요.",
  in_use:
    "다른 앱이나 탭에서 마이크를 이미 쓰고 있어요. 다른 통화·녹음 앱을 닫고 다시 점검하거나, 마이크 없이 글로 답하며 진행할 수 있어요.",
  timeout:
    "마이크 응답이 없어요. 마이크가 없거나 권한 창이 막혀 있을 수 있어요. 다시 점검하거나, 마이크 없이 글로 답하며 진행할 수 있어요.",
  unknown:
    "마이크를 확인하는 중 문제가 생겼어요. 기기 연결을 확인하고 다시 점검하거나, 마이크 없이 글로 답하며 진행할 수 있어요.",
};

/**
 * Stop every track on a MediaStream safely so the microphone indicator does not stay on.
 */
export function stopStreamTracks(stream: MediaStream | null | undefined): void {
  if (!stream || typeof stream.getTracks !== "function") return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // ignore track stop failure
    }
  }
}

/**
 * Map a getUserMedia error object's name to a normalized MicFailReason.
 */
export function mapMicErrorReason(err: unknown): MicFailReason {
  const name =
    err && typeof err === "object" && "name" in err
      ? String((err as { name?: unknown }).name || "")
      : "";

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "not_found";
    case "NotReadableError":
    case "TrackStartError":
      return "in_use";
    case "NotSupported":
    case "NotSupportedError":
      return "unsupported";
    default:
      return "unknown";
  }
}

export const WRITTEN_ANSWER_MAX_LENGTH = 500;
export const WRITTEN_ANSWER_PREFIX = "The learner answers in writing: ";

export interface FormattedWrittenAnswer {
  displayText: string;
  prompt: string;
}

/**
 * Normalize and validate a learner's written answer for in-call text fallback.
 * Returns null when the input is blank/whitespace-only.
 */
export function formatWrittenAnswer(text: string): FormattedWrittenAnswer | null {
  const displayText = (text ?? "").trim().slice(0, WRITTEN_ANSWER_MAX_LENGTH);
  if (!displayText) return null;
  return {
    displayText,
    prompt: `${WRITTEN_ANSWER_PREFIX}${displayText}`,
  };
}

/**
 * Check microphone availability with an upper timeout bound.
 * If a stream resolves after timing out, all of its tracks are immediately stopped.
 */
export function checkMicrophone(
  getUserMedia: GetUserMediaFn | null | undefined,
  timeoutMs = 8000
): Promise<MicCheckResult> {
  if (typeof getUserMedia !== "function") {
    return Promise.resolve({
      ok: false,
      reason: "unsupported",
      message: MIC_FAIL_MESSAGES.unsupported,
    });
  }

  const safeTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 8000;

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timedOut = true;
      resolve({
        ok: false,
        reason: "timeout",
        message: MIC_FAIL_MESSAGES.timeout,
      });
    }, safeTimeoutMs);

    Promise.resolve()
      .then(() => getUserMedia({ audio: true }))
      .then((stream) => {
        clearTimeout(timer);
        if (timedOut || settled) {
          stopStreamTracks(stream);
          return;
        }
        settled = true;
        resolve({ ok: true, stream });
      })
      .catch((err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        const reason = mapMicErrorReason(err);
        resolve({
          ok: false,
          reason,
          message: MIC_FAIL_MESSAGES[reason],
        });
      });
  });
}
