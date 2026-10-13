import { MistakeItem, PostCallReview, MorningPodcast, UserProfileSettings, TrackId } from '../types';

const STORAGE_KEYS = {
  MISTAKES: 'onecall_mistakes_v1',
  PROGRESS: 'onecall_progress_v1',
  REVIEWS: 'onecall_reviews_v1',
  PODCASTS: 'onecall_podcasts_v1',
  PROFILE: 'onecall_profile_v1',
};

const DEFAULT_PROFILE: UserProfileSettings = {
  jobRole: '생산관리 엔지니어 (Production Planning Engineer)',
  postingTarget: '한화 필리 조선소 (Hanwha Philly Shipyard, Philadelphia)',
  surveyTopics: 'watching movies, going to parks, domestic travel, overseas travel, jogging',
  telegramBotToken: '',
  telegramChatId: '',
};

const INITIAL_MISTAKES: MistakeItem[] = [
  {
    id: 'mistake-1',
    createdAt: '2026-10-10 22:30',
    trackId: 'opic',
    lessonTitle: '1과: 자기소개',
    myPhrase: 'I am working in shipyard since five years.',
    naturalPhrase: 'I have been working in the shipbuilding industry for five years.',
    reason: '과거부터 현재까지 지속되는 경력 표현에는 현재완료 진행형(have been working)이 정확함.',
    reviewed: false,
  },
  {
    id: 'mistake-2',
    createdAt: '2026-10-10 22:32',
    trackId: 'opic',
    lessonTitle: '1과: 자기소개',
    myPhrase: 'Next year, I dispatch to America Philly.',
    naturalPhrase: 'Next year, I will be posted to the Philly Shipyard in the US as an expatriate.',
    reason: '주재원 파견 발령은 "be posted as an expat" 또는 "assigned to"가 가장 자연스러운 비즈니스 표현.',
    reviewed: false,
  },
  {
    id: 'mistake-3',
    createdAt: '2026-10-11 22:15',
    trackId: 'opic',
    lessonTitle: '2과: 집 묘사',
    myPhrase: 'My apartment has three rooms and near the station.',
    naturalPhrase: 'My apartment is a three-bedroom unit located within walking distance of the station.',
    reason: '방 개수는 three-bedroom apartment, 역 근처는 within walking distance of로 세련되게 격상.',
    reviewed: false,
  },
];

export const AppStorage = {
  // 1. User Profile Settings
  getProfile(): UserProfileSettings {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.PROFILE);
      if (data) return { ...DEFAULT_PROFILE, ...JSON.parse(data) };
    } catch {
      // fallback
    }
    return DEFAULT_PROFILE;
  },

  saveProfile(profile: Partial<UserProfileSettings>): void {
    const current = this.getProfile();
    const updated = { ...current, ...profile };
    localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(updated));
  },

  // 2. Mistake Vault
  getMistakes(): MistakeItem[] {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.MISTAKES);
      if (data) return JSON.parse(data);
    } catch {
      // fallback
    }
    // Seed initial mistakes if empty
    this.saveMistakes(INITIAL_MISTAKES);
    return INITIAL_MISTAKES;
  },

  saveMistakes(items: MistakeItem[]): void {
    localStorage.setItem(STORAGE_KEYS.MISTAKES, JSON.stringify(items));
  },

  addMistakes(newMistakes: Omit<MistakeItem, 'id' | 'createdAt' | 'reviewed'>[]): MistakeItem[] {
    const current = this.getMistakes();
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const created: MistakeItem[] = newMistakes.map((m, idx) => ({
      ...m,
      id: `mistake-${Date.now()}-${idx}`,
      createdAt: nowStr,
      reviewed: false,
    }));
    const updated = [...created, ...current];
    this.saveMistakes(updated);
    return updated;
  },

  toggleMistakeReviewed(id: string): MistakeItem[] {
    const current = this.getMistakes();
    const updated = current.map((m) => (m.id === id ? { ...m, reviewed: !m.reviewed } : m));
    this.saveMistakes(updated);
    return updated;
  },

  getUnreviewedMistakes(): MistakeItem[] {
    return this.getMistakes().filter((m) => !m.reviewed);
  },

  // 3. Track Progress (Next Lesson Tracker)
  getProgress(): Record<TrackId, number> {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.PROGRESS);
      if (data) return JSON.parse(data);
    } catch {
      // fallback
    }
    return {
      opic: 2, // 10/11까지 2과 완료 상태로 시작
      philly: 0,
      travel: 0,
      bluey: 0,
    };
  },

  saveProgress(trackId: TrackId, completedLessonNum: number): void {
    const current = this.getProgress();
    current[trackId] = Math.max(current[trackId] || 0, completedLessonNum);
    localStorage.setItem(STORAGE_KEYS.PROGRESS, JSON.stringify(current));
  },

  // 4. Post-Call Reviews
  getReviews(): PostCallReview[] {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.REVIEWS);
      if (data) return JSON.parse(data);
    } catch {
      // fallback
    }
    return [];
  },

  saveReview(review: PostCallReview): void {
    const current = this.getReviews();
    const updated = [review, ...current].slice(0, 50); // keep recent 50
    localStorage.setItem(STORAGE_KEYS.REVIEWS, JSON.stringify(updated));
  },

  // 5. Morning Podcasts
  getPodcasts(): MorningPodcast[] {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.PODCASTS);
      if (data) return JSON.parse(data);
    } catch {
      // fallback
    }
    return [];
  },

  savePodcast(podcast: MorningPodcast): void {
    const current = this.getPodcasts();
    const updated = [podcast, ...current].slice(0, 30);
    localStorage.setItem(STORAGE_KEYS.PODCASTS, JSON.stringify(updated));
  },
};
