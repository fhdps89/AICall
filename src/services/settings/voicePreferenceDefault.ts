import { getUserSettings, saveUserSettings } from "../firebase/db";
import { createVoicePreference } from "./voicePreference";

const defaultVoicePreference = createVoicePreference({
  readRemote: async (userId: string) => {
    const settings = await getUserSettings(userId);
    return settings.voiceName;
  },
  writeRemote: async (userId: string, voiceName: string) => {
    await saveUserSettings(userId, { voiceName });
  },
});

export const getPreferredVoice = defaultVoicePreference.getPreferredVoice;
export const setPreferredVoice = defaultVoicePreference.setPreferredVoice;
export const clearVoicePreferenceCache = defaultVoicePreference.clearCache;
