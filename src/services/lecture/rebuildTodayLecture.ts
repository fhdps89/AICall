import { syncFeed } from "../feed/feedService";
import { getKSTToday } from "../firebase/db";
import { startLecture, type LectureDoc } from "./lectureService";

export interface RebuildTodayLectureDeps {
  syncFeed: (uid: string, opts?: { autoRegenerate?: boolean }) => Promise<unknown>;
  startLecture: (uid: string, date?: string, force?: boolean) => Promise<LectureDoc>;
}

/**
 * Sync the latest review/mistake candidates first (best-effort), then trigger
 * today's lecture generation with force=true.
 */
export async function rebuildTodayLectureWith(
  uid: string,
  date: string,
  deps: RebuildTodayLectureDeps
): Promise<LectureDoc> {
  try {
    await deps.syncFeed(uid, { autoRegenerate: false });
  } catch {
    console.warn("피드 동기화에 실패했지만 오늘 강의를 다시 만듭니다.");
  }
  return deps.startLecture(uid, date, true);
}

export function rebuildTodayLecture(uid: string, date = getKSTToday()): Promise<LectureDoc> {
  return rebuildTodayLectureWith(uid, date, {
    syncFeed: (u, opts) => syncFeed(u, undefined, undefined, opts),
    startLecture,
  });
}
