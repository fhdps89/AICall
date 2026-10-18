import path from 'path';

/**
 * Absolute path for a recording file inside the signed-in user's own folder, or null when the
 * requested path would leave that folder (e.g. "../other-user/x.webm").
 */
export function userRecordingPath(recordingsDir: string, uid: string, relPath: string): string | null {
  const userDir = path.join(recordingsDir, uid.replace(/[^a-zA-Z0-9_\-]/g, '_'));
  const resolved = path.resolve(userDir, relPath.replace(/[^a-zA-Z0-9_\-\.\/]/g, '_'));
  return resolved.startsWith(userDir + path.sep) ? resolved : null; // blocks ../ traversal
}
