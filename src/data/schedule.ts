import { ScheduleItem, TrackId } from '../types';

export const WEEKLY_PATTERN = [
  { day: '월', trackId: 'opic' as TrackId, roomName: '🎯 OPIc 코치', defaultMinutes: 30 },
  { day: '화', trackId: 'philly' as TrackId, roomName: '🏭 Philly 출근', defaultMinutes: 25 },
  { day: '수', trackId: 'bluey' as TrackId, roomName: '🦘 Bluey 리스닝', defaultMinutes: 25 },
  { day: '목', trackId: 'philly' as TrackId, roomName: '🏭 Philly 출근', defaultMinutes: 25 },
  { day: '금', trackId: 'travel' as TrackId, roomName: '✈️ 여행', defaultMinutes: 25 },
  { day: '토', trackId: 'opic' as TrackId, roomName: '🎯 OPIc 코치', defaultMinutes: 30 },
  { day: '일', trackId: 'opic' as TrackId, roomName: '주간 복기', defaultMinutes: 15 },
];

export const MASTER_SCHEDULE: ScheduleItem[] = [
  // 시작 주 (10/10~10/11)
  {
    date: '2026-10-10',
    dayOfWeek: '토',
    trackId: 'opic',
    lessonNum: 1,
    title: '🎯 OPIc 코치 · 1과: 자기소개',
    durationMinutes: 50,
    note: '1~4단계 세팅 + 1과 진행',
  },
  {
    date: '2026-10-11',
    dayOfWeek: '일',
    trackId: 'opic',
    lessonNum: 2,
    title: '🎯 OPIc 코치 · 2과: 집(묘사·습관·변화)',
    durationMinutes: 30,
  },

  // 1주차 (10/12(월)~10/18(일))
  {
    date: '2026-10-12',
    dayOfWeek: '월',
    trackId: 'opic',
    lessonNum: 3,
    title: '🎯 OPIc 코치 · 3과: 동네',
    durationMinutes: 30,
  },
  {
    date: '2026-10-13',
    dayOfWeek: '화',
    trackId: 'philly',
    lessonNum: 1,
    title: '🏭 Philly 출근 · 1과: 첫 출근 인사',
    durationMinutes: 25,
  },
  {
    date: '2026-10-14',
    dayOfWeek: '수',
    trackId: 'bluey',
    lessonNum: 1,
    title: '🦘 Bluey · 1과: S1E01 The Magic Xylophone',
    durationMinutes: 25,
  },
  {
    date: '2026-10-15',
    dayOfWeek: '목',
    trackId: 'philly',
    lessonNum: 2,
    title: '🏭 Philly 출근 · 2과: 아침 생산 회의',
    durationMinutes: 25,
  },
  {
    date: '2026-10-16',
    dayOfWeek: '금',
    trackId: 'travel',
    lessonNum: 1,
    title: '✈️ 여행 · 1과: 미국: 입국 심사',
    durationMinutes: 25,
  },
  {
    date: '2026-10-17',
    dayOfWeek: '토',
    trackId: 'opic',
    lessonNum: 4,
    title: '🎯 OPIc 코치 · 4과: 설문 주제 1',
    durationMinutes: 30,
  },
  {
    date: '2026-10-18',
    dayOfWeek: '일',
    trackId: 'opic',
    lessonNum: 4,
    title: '주간 복기 (Keep 실수 패턴 5개) + 이번 주 Bluey 복습',
    durationMinutes: 15,
    note: '주간 복기 세션',
  },

  // 2주차 (10/19(월)~10/25(일))
  {
    date: '2026-10-19',
    dayOfWeek: '월',
    trackId: 'opic',
    lessonNum: 5,
    title: '🎯 OPIc 코치 · 5과: 설문 주제 2',
    durationMinutes: 30,
  },
  {
    date: '2026-10-20',
    dayOfWeek: '화',
    trackId: 'philly',
    lessonNum: 3,
    title: '🏭 Philly 출근 · 3과: 지연 보고와 만회 계획',
    durationMinutes: 25,
  },
  {
    date: '2026-10-21',
    dayOfWeek: '수',
    trackId: 'bluey',
    lessonNum: 2,
    title: '🦘 Bluey · 2과: S1E02 Hospital',
    durationMinutes: 25,
  },
  {
    date: '2026-10-22',
    dayOfWeek: '목',
    trackId: 'philly',
    lessonNum: 4,
    title: '🏭 Philly 출근 · 4과: 안전 미팅(toolbox talk)',
    durationMinutes: 25,
  },
  {
    date: '2026-10-23',
    dayOfWeek: '금',
    trackId: 'travel',
    lessonNum: 2,
    title: '✈️ 여행 · 2과: 미국: 렌터카',
    durationMinutes: 25,
  },
  {
    date: '2026-10-24',
    dayOfWeek: '토',
    trackId: 'opic',
    lessonNum: 6,
    title: '🎯 OPIc 코치 · 6과: 설문 주제 3',
    durationMinutes: 30,
  },
  {
    date: '2026-10-25',
    dayOfWeek: '일',
    trackId: 'opic',
    lessonNum: 6,
    title: '주간 복기 (Keep 실수 패턴 5개) + Bluey 다시 보기',
    durationMinutes: 15,
  },

  // 3주차 (10/26(월)~11/1(일))
  {
    date: '2026-10-26',
    dayOfWeek: '월',
    trackId: 'opic',
    lessonNum: 7,
    title: '🎯 OPIc 코치 · 7과: 국내여행',
    durationMinutes: 30,
  },
  {
    date: '2026-10-27',
    dayOfWeek: '화',
    trackId: 'philly',
    lessonNum: 5,
    title: '🏭 Philly 출근 · 5과: 기술 문제 설명',
    durationMinutes: 25,
  },
  {
    date: '2026-10-28',
    dayOfWeek: '수',
    trackId: 'bluey',
    lessonNum: 3,
    title: '🦘 Bluey · 3과: S1E03 Keepy Uppy',
    durationMinutes: 25,
  },
  {
    date: '2026-10-29',
    dayOfWeek: '목',
    trackId: 'philly',
    lessonNum: 6,
    title: '🏭 Philly 출근 · 6과: 정중하게 반대하기',
    durationMinutes: 25,
  },
  {
    date: '2026-10-30',
    dayOfWeek: '금',
    trackId: 'travel',
    lessonNum: 3,
    title: '✈️ 여행 · 3과: 미국: 호텔 체크인 문제',
    durationMinutes: 25,
  },
  {
    date: '2026-10-31',
    dayOfWeek: '토',
    trackId: 'opic',
    lessonNum: 8,
    title: '🎯 OPIc 코치 · 8과: 해외여행',
    durationMinutes: 30,
  },
  {
    date: '2026-11-01',
    dayOfWeek: '일',
    trackId: 'opic',
    lessonNum: 8,
    title: '주간 복기 (Keep 실수 패턴 5개)',
    durationMinutes: 15,
  },

  // 4주차 (11/2(월)~11/8(일))
  {
    date: '2026-11-02',
    dayOfWeek: '월',
    trackId: 'opic',
    lessonNum: 9,
    title: '🎯 OPIc 코치 · 9과: 롤플레이 A(질문하기)',
    durationMinutes: 30,
  },
  {
    date: '2026-11-03',
    dayOfWeek: '화',
    trackId: 'philly',
    lessonNum: 7,
    title: '🏭 Philly 출근 · 7과: 업체 통화(납기 지연)',
    durationMinutes: 25,
  },
  {
    date: '2026-11-04',
    dayOfWeek: '수',
    trackId: 'bluey',
    lessonNum: 4,
    title: '🦘 Bluey · 4과: S1E04 Daddy Robot',
    durationMinutes: 25,
  },
  {
    date: '2026-11-05',
    dayOfWeek: '목',
    trackId: 'philly',
    lessonNum: 8,
    title: '🏭 Philly 출근 · 8과: 스몰토크: 월요일·주말',
    durationMinutes: 25,
  },
  {
    date: '2026-11-06',
    dayOfWeek: '금',
    trackId: 'travel',
    lessonNum: 4,
    title: '✈️ 여행 · 4과: 미국: 식당·팁',
    durationMinutes: 25,
  },
  {
    date: '2026-11-07',
    dayOfWeek: '토',
    trackId: 'opic',
    lessonNum: 10,
    title: '🎯 OPIc 코치 · 10과: 롤플레이 B(문제 해결)',
    durationMinutes: 30,
  },
  {
    date: '2026-11-08',
    dayOfWeek: '일',
    trackId: 'opic',
    lessonNum: 10,
    title: '주간 복기 (Keep 실수 패턴 5개)',
    durationMinutes: 15,
  },

  // 5주차 (11/9(월)~11/15(일))
  {
    date: '2026-11-09',
    dayOfWeek: '월',
    trackId: 'opic',
    lessonNum: 11,
    title: '🎯 OPIc 코치 · 11과: 롤플레이 C(비슷한 경험)',
    durationMinutes: 30,
  },
  {
    date: '2026-11-10',
    dayOfWeek: '화',
    trackId: 'philly',
    lessonNum: 9,
    title: '🏭 Philly 출근 · 9과: 스몰토크: 점심·Eagles/Phillies',
    durationMinutes: 25,
  },
  {
    date: '2026-11-11',
    dayOfWeek: '수',
    trackId: 'bluey',
    lessonNum: 5,
    title: '🦘 Bluey · 5과: S1E05 + 5편 복습 퀴즈',
    durationMinutes: 25,
  },
  {
    date: '2026-11-12',
    dayOfWeek: '목',
    trackId: 'philly',
    lessonNum: 10,
    title: '🏭 Philly 출근 · 10과: 본사 결정 전달하기',
    durationMinutes: 25,
  },
  {
    date: '2026-11-13',
    dayOfWeek: '금',
    trackId: 'travel',
    lessonNum: 5,
    title: '✈️ 여행 · 5과: 미국: 약국(아이 열)',
    durationMinutes: 25,
  },
  {
    date: '2026-11-14',
    dayOfWeek: '토',
    trackId: 'opic',
    lessonNum: 12,
    title: '🎯 OPIc 코치 · 12과: 돌발 주제',
    durationMinutes: 30,
  },
  {
    date: '2026-11-15',
    dayOfWeek: '일',
    trackId: 'opic',
    lessonNum: 12,
    title: '주간 복기 (Keep 실수 패턴 5개)',
    durationMinutes: 15,
  },

  // 6주차 (11/16(월)~11/22(일))
  {
    date: '2026-11-16',
    dayOfWeek: '월',
    trackId: 'opic',
    lessonNum: 13,
    title: '🎯 OPIc 코치 · 13과: 사회 이슈·비교',
    durationMinutes: 30,
  },
  {
    date: '2026-11-17',
    dayOfWeek: '화',
    trackId: 'philly',
    lessonNum: 11,
    title: '🏭 Philly 출근 · 11과: 못 알아들었을 때 되묻기',
    durationMinutes: 25,
  },
  {
    date: '2026-11-18',
    dayOfWeek: '수',
    trackId: 'bluey',
    lessonNum: 6,
    title: '🦘 Bluey · 6과: S1E06 The Weekend',
    durationMinutes: 25,
  },
  {
    date: '2026-11-19',
    dayOfWeek: '목',
    trackId: 'philly',
    lessonNum: 12,
    title: '🏭 Philly 출근 · 12과: 주간 보고 발표',
    durationMinutes: 25,
  },
  {
    date: '2026-11-20',
    dayOfWeek: '금',
    trackId: 'travel',
    lessonNum: 6,
    title: '✈️ 여행 · 6과: 미국: 놀이공원·박물관',
    durationMinutes: 25,
  },
  {
    date: '2026-11-21',
    dayOfWeek: '토',
    trackId: 'opic',
    lessonNum: 14,
    title: '🎯 OPIc 코치 · 14과: 실전 모의고사 15문항',
    durationMinutes: 30,
    note: '★ 이정표: 첫 번째 전체 점검 모의고사',
  },
  {
    date: '2026-11-22',
    dayOfWeek: '일',
    trackId: 'opic',
    lessonNum: 14,
    title: '주간 복기 (Keep 실수 패턴 5개)',
    durationMinutes: 15,
  },
];

// Helper: Get today's date formatted as YYYY-MM-DD in KST
export function getKstDateString(dateObj: Date = new Date()): string {
  const utc = dateObj.getTime() + dateObj.getTimezoneOffset() * 60000;
  const kstTime = new Date(utc + 9 * 3600000);
  const year = kstTime.getFullYear();
  const month = String(kstTime.getMonth() + 1).padStart(2, '0');
  const day = String(kstTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Get scheduled item for specific date, or fallback to weekly pattern
export function getScheduleForDate(dateStr: string): ScheduleItem {
  const found = MASTER_SCHEDULE.find((s) => s.date === dateStr);
  if (found) return found;

  // Fallback to day-of-week pattern
  const parsed = new Date(dateStr);
  const dayIndex = parsed.getDay(); // 0 is Sun, 1 is Mon...
  const dayNames: Array<'일' | '월' | '화' | '수' | '목' | '금' | '토'> = [
    '일',
    '월',
    '화',
    '수',
    '목',
    '금',
    '토',
  ];
  const dayName = dayNames[dayIndex] || '월';
  const pattern = WEEKLY_PATTERN.find((p) => p.day === dayName) || WEEKLY_PATTERN[0];

  return {
    date: dateStr,
    dayOfWeek: dayName,
    trackId: pattern.trackId,
    lessonNum: 1,
    title: `${pattern.roomName} · 추천 레슨`,
    durationMinutes: pattern.defaultMinutes,
  };
}

export function getTodaySchedule(): ScheduleItem {
  const todayStr = getKstDateString();
  return getScheduleForDate(todayStr);
}
