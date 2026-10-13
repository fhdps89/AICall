import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
} from "firebase/auth";
import { auth } from "./config";

export const ALLOWED_USER_EMAIL = "episode.kim@gmail.com";

export class UnauthorizedUserError extends Error {
  constructor(email: string | null) {
    super(
      `허용되지 않은 계정입니다 (${email || "알 수 없음"}). 본 애플리케이션은 1인 전용으로 등록된 계정(${ALLOWED_USER_EMAIL})으로만 로그인할 수 있습니다.`
    );
    this.name = "UnauthorizedUserError";
  }
}

/**
 * Perform Google Sign-in with single-user account verification
 */
export async function signInWithGoogle(): Promise<User> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({
    prompt: "select_account",
  });

  const credential = await signInWithPopup(auth, provider);
  const user = credential.user;

  if (user.email?.toLowerCase() !== ALLOWED_USER_EMAIL.toLowerCase()) {
    await signOut(auth);
    throw new UnauthorizedUserError(user.email);
  }

  return user;
}

/**
 * Sign out current session
 */
export async function logOut(): Promise<void> {
  await signOut(auth);
}

/**
 * Subscribe to auth state changes with single allowed email guard
 */
export function subscribeToAuth(
  callback: (user: User | null, error: Error | null) => void
): () => void {
  return onAuthStateChanged(auth, async (user) => {
    if (user) {
      if (user.email?.toLowerCase() !== ALLOWED_USER_EMAIL.toLowerCase()) {
        try {
          await signOut(auth);
        } catch {
          // ignore
        }
        callback(null, new UnauthorizedUserError(user.email));
        return;
      }
      callback(user, null);
    } else {
      callback(null, null);
    }
  });
}
