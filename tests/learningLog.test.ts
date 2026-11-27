import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDaysToDateStr,
  callUsageDelta,
  callsForDuration,
  deriveHomeLearningStatus,
  getRecentMonthKeys,
  kstDateStr,
  liveContextMinutesSq,
  restBannerTitle,
  summarizeLearningLog,
  type LearningLogSummary,
} from '../src/services/usage/learningLog.ts';
import {
  buildUsageFields,
  buildUsagePayload,
  estimateCostUsd,
  priceUsage,
  type UsageMonth,
} from '../src/services/usage/usageService.ts';

function makeMonth(
  days: Record<string, { calls?: number; liveMinutes?: number }>,
  overrides: Partial<UsageMonth> = {}
): UsageMonth {
  let totalCalls = 0;
  let totalMinutes = 0;
  for (const d of Object.values(days)) {
    totalCalls += d.calls ?? 0;
    totalMinutes += d.liveMinutes ?? 0;
  }
  return {
    liveMinutes: totalMinutes,
    sttMinutes: 0,
    textTokens: 0,
    ttsChars: 0,
    estCostUsd: 0,
    calls: totalCalls,
    days,
    ...overrides,
  };
}

test('empty input returns zero summary and 14 zeroed recentDays', () => {
  const res = summarizeLearningLog({}, '2026-11-21');
  assert.deepEqual(res.today, { calls: 0, minutes: 0 });
  assert.deepEqual(res.thisMonth, { calls: 0, minutes: 0, activeDays: 0 });
  assert.equal(res.streakDays, 0);
  assert.equal(res.bestStreakDays, 0);
  assert.equal(res.recentDays.length, 14);
  assert.equal(res.recentDays[0].date, '2026-11-08');
  assert.equal(res.recentDays[13].date, '2026-11-21');
  assert.ok(res.recentDays.every((d) => d.calls === 0 && d.minutes === 0));

  const nullMonthRes = summarizeLearningLog({ '2026-11': null }, '2026-11-21');
  assert.equal(nullMonthRes.streakDays, 0);
  assert.equal(nullMonthRes.recentDays.length, 14);
});

test('today calls present vs absent updates today and thisMonth', () => {
  const withToday = summarizeLearningLog(
    {
      '2026-11': makeMonth({
        '19': { calls: 1, liveMinutes: 5 },
        '21': { calls: 2, liveMinutes: 12.5 },
      }),
    },
    '2026-11-21'
  );
  assert.deepEqual(withToday.today, { calls: 2, minutes: 12.5 });
  assert.deepEqual(withToday.thisMonth, { calls: 3, minutes: 17.5, activeDays: 2 });

  const withoutToday = summarizeLearningLog(
    {
      '2026-11': makeMonth({
        '20': { calls: 1, liveMinutes: 6 },
      }),
    },
    '2026-11-21'
  );
  assert.deepEqual(withoutToday.today, { calls: 0, minutes: 0 });
  assert.deepEqual(withoutToday.thisMonth, { calls: 1, minutes: 6, activeDays: 1 });
});

test('streak handles today included, today excluded + yesterday included, and neither -> 0', () => {
  // 오늘 포함 3일 연속
  const incToday = summarizeLearningLog(
    {
      '2026-11': makeMonth({
        '19': { calls: 1, liveMinutes: 3 },
        '20': { calls: 1, liveMinutes: 4 },
        '21': { calls: 1, liveMinutes: 5 },
      }),
    },
    '2026-11-21'
  );
  assert.equal(incToday.streakDays, 3);

  // 오늘 아직 안 함 + 어제까지 2일 연속
  const incYesterday = summarizeLearningLog(
    {
      '2026-11': makeMonth({
        '17': { calls: 1, liveMinutes: 3 },
        '19': { calls: 1, liveMinutes: 4 },
        '20': { calls: 1, liveMinutes: 5 },
      }),
    },
    '2026-11-21'
  );
  assert.equal(incYesterday.streakDays, 2);

  // 오늘도 어제도 안 함 -> 0
  const broken = summarizeLearningLog(
    {
      '2026-11': makeMonth({
        '18': { calls: 1, liveMinutes: 5 },
        '19': { calls: 1, liveMinutes: 5 },
      }),
    },
    '2026-11-21'
  );
  assert.equal(broken.streakDays, 0);
  assert.equal(broken.bestStreakDays, 2);
});

test('streak and recentDays cross month boundary (last day -> 1st)', () => {
  const res = summarizeLearningLog(
    {
      '2026-10': makeMonth({
        '30': { calls: 1, liveMinutes: 5 },
        '31': { calls: 1, liveMinutes: 7 },
      }),
      '2026-11': makeMonth({
        '01': { calls: 1, liveMinutes: 6 },
      }),
    },
    '2026-11-01'
  );
  assert.equal(res.streakDays, 3);
  assert.equal(res.bestStreakDays, 3);
  assert.equal(res.recentDays.length, 14);
  assert.equal(res.recentDays[0].date, '2026-10-19');
  assert.equal(res.recentDays[11].date, '2026-10-30');
  assert.equal(res.recentDays[12].date, '2026-10-31');
  assert.equal(res.recentDays[13].date, '2026-11-01');
  assert.equal(res.recentDays[12].minutes, 7);
});

test('streak handles leap year Feb 29 and non-leap year Feb 28', () => {
  const leap = summarizeLearningLog(
    {
      '2024-02': makeMonth({
        '28': { calls: 1, liveMinutes: 4 },
        '29': { calls: 1, liveMinutes: 5 },
      }),
      '2024-03': makeMonth({
        '01': { calls: 1, liveMinutes: 6 },
      }),
    },
    '2024-03-01'
  );
  assert.equal(leap.streakDays, 3);
  assert.equal(addDaysToDateStr('2024-03-01', -1), '2024-02-29');

  const nonLeap = summarizeLearningLog(
    {
      '2025-02': makeMonth({
        '28': { calls: 1, liveMinutes: 5 },
      }),
      '2025-03': makeMonth({
        '01': { calls: 1, liveMinutes: 6 },
      }),
    },
    '2025-03-01'
  );
  assert.equal(nonLeap.streakDays, 2);
  assert.equal(addDaysToDateStr('2025-03-01', -1), '2025-02-28');
});

test('streak and recentMonthKeys cross year end (Dec -> Jan)', () => {
  const res = summarizeLearningLog(
    {
      '2025-12': makeMonth({
        '30': { calls: 1, liveMinutes: 5 },
        '31': { calls: 1, liveMinutes: 5 },
      }),
      '2026-01': makeMonth({
        '01': { calls: 1, liveMinutes: 5 },
      }),
    },
    '2026-01-01'
  );
  assert.equal(res.streakDays, 3);
  assert.deepEqual(getRecentMonthKeys('2026-01-01', 3), ['2026-01', '2025-12', '2025-11']);
});

test('legacy data without calls uses liveMinutes >= 0.5 threshold; calls > 0 also counts', () => {
  const legacyMonth: UsageMonth = {
    liveMinutes: 5.69,
    sttMinutes: 0,
    textTokens: 0,
    ttsChars: 0,
    estCostUsd: 0,
    days: {
      '18': { liveMinutes: 0.49 }, // 미달 (calls 없음)
      '19': { liveMinutes: 0.5 },  // 경계값 포함
      '20': { liveMinutes: 4.5 },  // 포함
      '21': { calls: 1, liveMinutes: 0.2 }, // calls > 0 이므로 포함 (10초 이상 통화)
    },
  };
  const res = summarizeLearningLog({ '2026-11': legacyMonth }, '2026-11-21');
  assert.equal(res.streakDays, 3); // 19, 20, 21 (18일은 0.49분이라 제외)
  assert.equal(res.thisMonth.activeDays, 3);
  assert.equal(res.thisMonth.calls, 1);
  assert.equal(res.thisMonth.minutes, 5.69);
});

test('bestStreakDays finds longest streak across multiple fetched months', () => {
  const res = summarizeLearningLog(
    {
      '2026-09': makeMonth({
        '28': { calls: 1, liveMinutes: 5 },
        '29': { calls: 1, liveMinutes: 5 },
        '30': { calls: 1, liveMinutes: 5 },
      }),
      '2026-10': makeMonth({
        '01': { calls: 1, liveMinutes: 5 },
        '02': { calls: 1, liveMinutes: 5 },
        '10': { calls: 1, liveMinutes: 5 },
      }),
      '2026-11': makeMonth({
        '20': { calls: 1, liveMinutes: 5 },
        '21': { calls: 1, liveMinutes: 5 },
      }),
    },
    '2026-11-21'
  );
  assert.equal(res.streakDays, 2);
  assert.equal(res.bestStreakDays, 5); // 9/28 ~ 10/02
});

test('recentDays always has length 14 sorted oldest to newest', () => {
  const res = summarizeLearningLog(
    {
      '2026-11': makeMonth({
        '08': { calls: 1, liveMinutes: 2 },
        '21': { calls: 2, liveMinutes: 10 },
      }),
    },
    '2026-11-21'
  );
  assert.equal(res.recentDays.length, 14);
  for (let i = 1; i < res.recentDays.length; i++) {
    assert.ok(res.recentDays[i - 1].date < res.recentDays[i].date);
    assert.equal(addDaysToDateStr(res.recentDays[i - 1].date, 1), res.recentDays[i].date);
  }
  assert.equal(res.recentDays[0].date, '2026-11-08');
  assert.equal(res.recentDays[0].calls, 1);
  assert.equal(res.recentDays[13].date, '2026-11-21');
  assert.equal(res.recentDays[13].calls, 2);
});

test('buildUsageFields includes calls and leaves estCostUsd unchanged', () => {
  const baseDelta = {
    liveMinutes: 5,
    liveMinutesSq: 25,
    sttMinutes: 2,
    textInputTokens: 1000,
    textOutputTokens: 500,
    ttsChars: 200,
  };
  const withoutCalls = buildUsageFields(baseDelta, (n) => n);
  const withCalls = buildUsageFields({ ...baseDelta, calls: 1 }, (n) => n);

  assert.equal(withoutCalls.calls, 0);
  assert.equal(withCalls.calls, 1);
  assert.equal(withCalls.estCostUsd, withoutCalls.estCostUsd);
  assert.equal(withCalls.estCostUsd, estimateCostUsd(baseDelta));
  assert.equal(withCalls.liveMinutes, 5);
  assert.equal(withCalls.textTokens, 1500);
});

test('callsForDuration counts calls only at 10 seconds or longer', () => {
  assert.equal(callsForDuration(0), 0);
  assert.equal(callsForDuration(9), 0);
  assert.equal(callsForDuration(9.9), 0);
  assert.equal(callsForDuration(10), 1);
  assert.equal(callsForDuration(600), 1);
});

test('buildUsagePayload writes identical fields to month total and days[day]', () => {
  const delta = {
    liveMinutes: 4.5,
    sttMinutes: 1.5,
    textInputTokens: 800,
    textOutputTokens: 200,
    ttsChars: 150,
    calls: 1,
  };
  const payload = buildUsagePayload(delta, '21', (n) => n, '2026-11-21T05:00:00.000Z');
  const { days, updatedAt, ...monthFields } = payload;

  assert.equal(updatedAt, '2026-11-21T05:00:00.000Z');
  assert.deepEqual(Object.keys(monthFields).sort(), Object.keys(days['21']).sort());
  assert.deepEqual(monthFields, days['21']);
  assert.equal(days['21'].calls, 1);
  assert.equal(days['21'].liveMinutes, 4.5);
  assert.equal(days['21'].estCostUsd, estimateCostUsd(delta));
});

test('summarizeLearningLog derives thisMonth solely from days sum so it matches today', () => {
  const mismatched = makeMonth(
    {
      '21': { calls: 1, liveMinutes: 3.5 },
    },
    { calls: 9, liveMinutes: 42 }
  );
  const res = summarizeLearningLog({ '2026-11': mismatched }, '2026-11-21');
  assert.deepEqual(res.today, { calls: 1, minutes: 3.5 });
  assert.deepEqual(res.thisMonth, { calls: 1, minutes: 3.5, activeDays: 1 });
});

function assertNoConflict(s: LearningLogSummary) {
  const h = deriveHomeLearningStatus(s);
  assert.ok(!(h.streakDays !== null && h.restDays !== null), 'streakDays and restDays must not coexist');
  return h;
}

test('kstDateStr converts UTC instants to KST date', () => {
  assert.equal(kstDateStr(Date.UTC(2026, 10, 20, 14, 59, 59, 999)), '2026-11-20');
  assert.equal(kstDateStr(Date.UTC(2026, 10, 20, 15, 0, 0)), '2026-11-21');
  assert.equal(kstDateStr(Date.UTC(2025, 11, 31, 15, 0, 0)), '2026-01-01');
  assert.equal(kstDateStr(Date.UTC(2028, 1, 28, 15, 0, 0)), '2028-02-29');
});

test('restDays is 0 and banner hidden when learned today', () => {
  const s = summarizeLearningLog({ '2026-11': makeMonth({ '21': { calls: 1 } }) }, '2026-11-21');
  const h = assertNoConflict(s);
  assert.equal(s.restDays, 0);
  assert.equal(s.lastActiveDate, '2026-11-21');
  assert.equal(h.streakDays, 1);
  assert.equal(h.restDays, null);
});

test('yesterday only: streak shown, no banner', () => {
  const s = summarizeLearningLog({ '2026-11': makeMonth({ '20': { calls: 1 } }) }, '2026-11-21');
  const h = assertNoConflict(s);
  assert.equal(s.restDays, 1);
  assert.equal(s.lastActiveDate, '2026-11-20');
  assert.equal(h.streakDays, 1);
  assert.equal(h.restDays, null);
});

test('two days ago only: banner 2, no streak', () => {
  const s = summarizeLearningLog({ '2026-11': makeMonth({ '19': { calls: 1 } }) }, '2026-11-21');
  const h = assertNoConflict(s);
  assert.equal(s.restDays, 2);
  assert.equal(s.lastActiveDate, '2026-11-19');
  assert.equal(h.streakDays, null);
  assert.equal(h.restDays, 2);
  assert.equal(restBannerTitle(2), '이틀째 쉬었어요. 오늘 수업만 해도 좋아요');
});

test('long rest shows N일째', () => {
  const s = summarizeLearningLog({ '2026-11': makeMonth({ '15': { calls: 1 } }) }, '2026-11-21');
  const h = assertNoConflict(s);
  assert.equal(s.restDays, 6);
  assert.equal(h.streakDays, null);
  assert.equal(h.restDays, 6);
  assert.equal(restBannerTitle(6), '6일째 쉬었어요. 오늘 수업만 해도 좋아요');
});

test('no records: no banner, no streak', () => {
  const empty = summarizeLearningLog({}, '2026-11-21');
  const hEmpty = assertNoConflict(empty);
  assert.equal(empty.restDays, null);
  assert.equal(empty.lastActiveDate, null);
  assert.deepEqual(hEmpty, { streakDays: null, restDays: null });

  const nullMonth = summarizeLearningLog({ '2026-11': null }, '2026-11-21');
  const hNull = assertNoConflict(nullMonth);
  assert.equal(nullMonth.restDays, null);
  assert.equal(nullMonth.lastActiveDate, null);
  assert.deepEqual(hNull, { streakDays: null, restDays: null });
});

test('restDays crosses month boundary', () => {
  const s = summarizeLearningLog(
    { '2026-10': makeMonth({ '30': { calls: 1 } }) },
    '2026-11-01'
  );
  const h = assertNoConflict(s);
  assert.equal(s.restDays, 2);
  assert.equal(s.lastActiveDate, '2026-10-30');
  assert.equal(h.restDays, 2);
});

test('restDays crosses year end', () => {
  const s = summarizeLearningLog(
    { '2025-12': makeMonth({ '31': { calls: 1 } }) },
    '2026-01-02'
  );
  const h = assertNoConflict(s);
  assert.equal(s.restDays, 2);
  assert.equal(s.lastActiveDate, '2025-12-31');
  assert.equal(h.restDays, 2);
});

test('restDays handles leap year Feb 29', () => {
  const leap = summarizeLearningLog(
    { '2028-02': makeMonth({ '28': { calls: 1 } }) },
    '2028-03-01'
  );
  const hLeap = assertNoConflict(leap);
  assert.equal(leap.restDays, 2);
  assert.equal(hLeap.restDays, 2);

  const nonLeap = summarizeLearningLog(
    { '2027-02': makeMonth({ '27': { calls: 1 } }) },
    '2027-03-01'
  );
  const hNonLeap = assertNoConflict(nonLeap);
  assert.equal(nonLeap.restDays, 2);
  assert.equal(hNonLeap.restDays, 2);
});

test('call under 10s does not reset rest', () => {
  const s = summarizeLearningLog(
    {
      '2026-11': makeMonth({
        '19': { calls: 1 },
        '21': { calls: callsForDuration(9), liveMinutes: 9 / 60 },
      }),
    },
    '2026-11-21'
  );
  const h = assertNoConflict(s);
  assert.equal(s.restDays, 2);
  assert.equal(h.streakDays, null);
  assert.equal(h.restDays, 2);
});

test('future-dated entries are ignored', () => {
  const s = summarizeLearningLog(
    {
      '2026-11': makeMonth({
        '19': { calls: 1 },
        '25': { calls: 1 },
      }),
    },
    '2026-11-21'
  );
  const h = assertNoConflict(s);
  assert.equal(s.lastActiveDate, '2026-11-19');
  assert.equal(s.restDays, 2);
  assert.equal(h.restDays, 2);
});

test('streak and rest banner never coexist (property)', () => {
  const today = '2026-03-02';
  const baseDates: string[] = [];
  for (let offset = 0; offset < 10; offset += 1) {
    baseDates.push(addDaysToDateStr(today, -offset));
  }

  for (let mask = 0; mask < 1024; mask += 1) {
    const febDays: Record<string, { calls: number }> = {};
    const marDays: Record<string, { calls: number }> = {};
    for (let bit = 0; bit < 10; bit += 1) {
      if ((mask & (1 << bit)) === 0) continue;
      const date = baseDates[bit];
      const monthKey = date.slice(0, 7);
      const dayKey = date.slice(8, 10);
      if (monthKey === '2026-02') {
        febDays[dayKey] = { calls: 1 };
      } else {
        marDays[dayKey] = { calls: 1 };
      }
    }
    const months: Record<string, UsageMonth> = {};
    if (Object.keys(febDays).length > 0) months['2026-02'] = makeMonth(febDays);
    if (Object.keys(marDays).length > 0) months['2026-03'] = makeMonth(marDays);

    const s = summarizeLearningLog(months, today);
    const h = assertNoConflict(s);
    if (h.restDays !== null) {
      assert.equal(s.streakDays, 0);
    }
  }
});

test('deriveHomeLearningStatus(null) hides both', () => {
  assert.deepEqual(deriveHomeLearningStatus(null), { streakDays: null, restDays: null });
});

test('callUsageDelta isolates QA calls from liveMinutes and calls while keeping qaLiveMinutes (A17)', () => {
  const m = 260 / 60;
  // 4.33 min is past the 4-minute compression cap (12k/6k → 9k avg tokens): 2·4·m − 4²
  assert.deepEqual(callUsageDelta(260, false), { liveMinutes: m, liveMinutesSq: liveContextMinutesSq(m), calls: 1 });
  assert.ok(Math.abs(liveContextMinutesSq(m) - (8 * m - 16)) < 1e-9);

  const qa = callUsageDelta(260, true);
  assert.deepEqual(qa, { qaLiveMinutes: m, qaLiveMinutesSq: liveContextMinutesSq(m) });
  assert.equal('liveMinutes' in qa, false);
  assert.equal('calls' in qa, false);

  const shortM = 5 / 60;
  assert.deepEqual(callUsageDelta(5, false), { liveMinutes: shortM, liveMinutesSq: shortM * shortM, calls: 0 });
  assert.deepEqual(callUsageDelta(Number.NaN, false), { liveMinutes: 0, liveMinutesSq: 0, calls: 0 });
});

test('callUsageDelta includes measured Live token fields for normal and QA calls when present', () => {
  const measured = {
    turns: 4,
    inAudio: 10_000,
    inText: 2_000,
    outAudio: 3_000,
    outText: 400,
    thoughts: 600,
    cached: 0,
    promptTokens: 12_000,
    responseTokens: 3_400,
    totalTokens: 16_000,
    unsplitPromptTokens: 0,
  };
  const normal = callUsageDelta(180, false, measured);
  assert.deepEqual(normal, {
    liveMinutes: 3,
    liveMinutesSq: 9,
    calls: 1,
    liveInputAudioTokens: 10_000,
    liveInputTextTokens: 2_000,
    liveOutputAudioTokens: 3_000,
    liveOutputTextTokens: 400,
    liveThoughtTokens: 600,
    liveMeasuredMinutes: 3,
    liveMeasuredMinutesSq: 9,
    liveMeasuredCalls: 1,
  });

  const qa = callUsageDelta(180, true, measured);
  assert.deepEqual(qa, {
    qaLiveMinutes: 3,
    qaLiveMinutesSq: 9,
    qaLiveInputAudioTokens: 10_000,
    qaLiveInputTextTokens: 2_000,
    qaLiveOutputAudioTokens: 3_000,
    qaLiveOutputTextTokens: 400,
    qaLiveThoughtTokens: 600,
    qaLiveMeasuredMinutes: 3,
    qaLiveMeasuredMinutesSq: 9,
  });
  assert.equal('calls' in qa, false);
  assert.equal('liveMeasuredCalls' in qa, false);

  // Zero/empty measured totals leave output unchanged (fallback to duration estimate)
  const emptyMeasured = {
    turns: 0,
    inAudio: 0,
    inText: 0,
    outAudio: 0,
    outText: 0,
    thoughts: 0,
    cached: 0,
    promptTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    unsplitPromptTokens: 0,
  };
  assert.deepEqual(callUsageDelta(180, false, emptyMeasured), { liveMinutes: 3, liveMinutesSq: 9, calls: 1 });
  assert.deepEqual(callUsageDelta(180, true, null), { qaLiveMinutes: 3, qaLiveMinutesSq: 9 });
});

test('liveContextMinutesSq supports custom windowTokens and falls back on invalid values', () => {
  // Default = 9k-token average (12k/6k compression)
  const defaultSq = liveContextMinutesSq(180);
  // Smaller window gives smaller sq for long calls
  const compressedSq = liveContextMinutesSq(180, 4_500);
  assert.ok(compressedSq < defaultSq);
  // Short call below the smaller cap (2 min) is unaffected (t^2)
  assert.equal(liveContextMinutesSq(1.5, 4_500), 2.25);
  // Invalid / non-positive windowTokens fall back to default
  assert.equal(liveContextMinutesSq(180, 0), defaultSq);
  assert.equal(liveContextMinutesSq(180, -100), defaultSq);
  assert.equal(liveContextMinutesSq(180, Number.NaN), defaultSq);
  assert.equal(liveContextMinutesSq(180, Number.POSITIVE_INFINITY), defaultSq);
});

test('qaLiveMinutes adds estCostUsd without counting as an active learning day or streak (A18)', () => {
  const qaDayFields = buildUsageFields({ qaLiveMinutes: 4, qaLiveMinutesSq: 16 }, (n) => n);
  assert.equal(qaDayFields.liveMinutes, 0);
  assert.equal(qaDayFields.calls, 0);
  assert.ok(qaDayFields.estCostUsd > 0);
  assert.ok(Math.abs(qaDayFields.estCostUsd - priceUsage({ qaLiveMinutes: 4, qaLiveMinutesSq: 16 }).total) < 1e-12);

  const monthOnlyQa: UsageMonth = {
    liveMinutes: qaDayFields.liveMinutes,
    sttMinutes: qaDayFields.sttMinutes,
    textTokens: qaDayFields.textTokens,
    ttsChars: qaDayFields.ttsChars,
    estCostUsd: qaDayFields.estCostUsd,
    calls: qaDayFields.calls,
    days: { '22': qaDayFields },
  };
  const summaryOnlyQa = summarizeLearningLog({ '2026-11': monthOnlyQa }, '2026-11-22');
  assert.deepEqual(summaryOnlyQa.today, { calls: 0, minutes: 0 });
  assert.equal(summaryOnlyQa.thisMonth.activeDays, 0);
  assert.equal(summaryOnlyQa.streakDays, 0);

  const monthWithYesterday = makeMonth(
    { '21': { calls: 1, liveMinutes: 5 } },
    { days: { '21': { calls: 1, liveMinutes: 5 }, '22': qaDayFields } }
  );
  const summaryWithYesterday = summarizeLearningLog({ '2026-11': monthWithYesterday }, '2026-11-22');
  assert.deepEqual(summaryWithYesterday.today, { calls: 0, minutes: 0 });
  assert.equal(summaryWithYesterday.thisMonth.activeDays, 1);
  assert.equal(summaryWithYesterday.streakDays, 1);
});
