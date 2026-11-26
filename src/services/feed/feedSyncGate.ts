import type { MistakeData } from "../firebase/db";

const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000;

export interface FeedSyncOptions {
  mistakes?: MistakeData[];
  secretOverride?: string;
  previousSecret?: string;
  autoRegenerate?: boolean;
}

export interface FeedSyncGateDeps<R = unknown> {
  run: (uid: string, opts: FeedSyncOptions) => Promise<R>;
  now: () => number;
  today: () => string;
  minIntervalMs?: number;
}

export interface FeedSyncGate<R = unknown> {
  fromHome(uid: string, mistakes?: MistakeData[]): Promise<void>;
  explicit(uid: string, opts?: FeedSyncOptions): Promise<R>;
  invalidate(uid: string): void;
}

/**
 * Coalesce and throttle background home feed syncs while keeping explicit
 * post-review/change/settings syncs serialized behind any in-flight sync.
 */
export function createFeedSyncGate<R = unknown>(
  deps: FeedSyncGateDeps<R>
): FeedSyncGate<R> {
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const inFlight = new Map<string, Promise<unknown>>();
  const lastSuccess = new Map<string, { at: number; date: string }>();

  const runTracked = (
    uid: string,
    syncOpts: FeedSyncOptions,
    meta: { waitFor?: Promise<unknown>; isExplicit?: boolean } = {}
  ): Promise<R> => {
    const p = (async (): Promise<R> => {
      if (meta.waitFor) {
        await meta.waitFor.catch(() => {});
      }
      // Capture start date before run so a sync crossing midnight isn't recorded as today.
      const startDate = deps.today();
      try {
        const result = await deps.run(uid, syncOpts);
        lastSuccess.set(uid, { at: deps.now(), date: startDate });
        return result;
      } catch (err) {
        // Clear any prior home throttle so returning home retries after an explicit sync fails.
        if (meta.isExplicit) {
          lastSuccess.delete(uid);
        }
        throw err;
      }
    })().finally(() => {
      if (inFlight.get(uid) === p) {
        inFlight.delete(uid);
      }
    });
    inFlight.set(uid, p);
    return p;
  };

  return {
    fromHome(uid: string, mistakes?: MistakeData[]): Promise<void> {
      const active = inFlight.get(uid);
      if (active) {
        return active.then(() => undefined);
      }
      const last = lastSuccess.get(uid);
      if (last && last.date === deps.today() && deps.now() - last.at < minIntervalMs) {
        return Promise.resolve();
      }
      return runTracked(uid, { mistakes }).then(() => undefined);
    },

    explicit(uid: string, opts: FeedSyncOptions = {}): Promise<R> {
      const prev = inFlight.get(uid);
      return runTracked(uid, opts, { waitFor: prev, isExplicit: true });
    },

    invalidate(uid: string): void {
      lastSuccess.delete(uid);
    },
  };
}
