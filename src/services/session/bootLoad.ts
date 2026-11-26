import type { GoalData, UserProfileData } from "../firebase/db";

export interface BootLoadDeps {
  getUserProfile: (uid: string) => Promise<UserProfileData | null>;
  saveUserProfile: (uid: string, profile: UserProfileData) => Promise<void>;
  getUserGoals: (uid: string) => Promise<GoalData[]>;
  batchInitGoals: (uid: string, goals: GoalData[]) => Promise<void>;
  defaultProfile: () => UserProfileData;
  defaultGoals: GoalData[];
}

/** Load user profile and goals in parallel, initializing missing defaults independently. */
export async function loadProfileAndGoals(
  uid: string,
  deps: BootLoadDeps
): Promise<{ profile: UserProfileData; goals: GoalData[] }> {
  const [existingProfile, existingGoals] = await Promise.all([
    deps.getUserProfile(uid),
    deps.getUserGoals(uid),
  ]);

  const profilePromise = existingProfile
    ? Promise.resolve(existingProfile)
    : (() => {
        const created = deps.defaultProfile();
        return deps.saveUserProfile(uid, created).then(() => created);
      })();

  const goalsPromise =
    existingGoals.length > 0
      ? Promise.resolve(existingGoals)
      : deps.batchInitGoals(uid, deps.defaultGoals).then(() => deps.defaultGoals);

  const [profile, goals] = await Promise.all([profilePromise, goalsPromise]);
  return { profile, goals };
}
