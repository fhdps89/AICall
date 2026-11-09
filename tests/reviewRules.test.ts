import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepKnownIds, mergeMinuteTranscripts } from '../src/services/review/reviewRules.ts';
import { friendlyError } from '../src/ui/common/friendlyError.ts';

test('review ids from the model: unknown, duplicate and non-string ids are dropped', () => {
  assert.deepEqual(keepKnownIds(['a', 'zzz', 'a', 7, null, 'b'], ['a', 'b', undefined]), ['a', 'b']);
  assert.deepEqual(keepKnownIds('a', ['a']), []);
  assert.deepEqual(keepKnownIds(undefined, ['a']), []);
});

test('final transcript: every minute succeeded', () => {
  const r = mergeMinuteTranscripts(['one', '', 'three']);
  assert.deepEqual(r, { text: 'one\nthree', source: 'sttFinal', missingMinutes: [] });
});

test('final transcript: a failed minute is filled from the in-call backup of the same minute', () => {
  const r = mergeMinuteTranscripts(['one', null, 'three'], [{ minuteIndex: 1, transcript: ' two ' }, { minuteIndex: 9, transcript: 'x' }]);
  assert.equal(r.text, 'one\ntwo\nthree');
  assert.equal(r.source, 'sttPartial_fallback');
  assert.deepEqual(r.missingMinutes, []);
});

test('final transcript: a minute with no backup is reported missing, the rest is kept', () => {
  const r = mergeMinuteTranscripts(['one', null], []);
  assert.equal(r.text, 'one');
  assert.deepEqual(r.missingMinutes, [1]);
  assert.equal(mergeMinuteTranscripts([null, null]).text, '');
});

test('error text shown to the user never carries internals', () => {
  const fallback = '문제가 생겼어요. 잠시 후 다시 시도해 주세요.';
  // Firestore helper throws a JSON dump with the account email and document path
  assert.equal(friendlyError(new Error(JSON.stringify({ error: 'x', authInfo: { email: 'a@b.c' }, path: 'users/u1' }))), fallback);
  assert.equal(friendlyError(new Error('/api/lecture/generate → 500')), fallback);
  assert.equal(friendlyError(new Error('Cannot read properties of undefined')), fallback);
  assert.equal(friendlyError(undefined), fallback);
  // Sentences written for the user pass through
  assert.equal(friendlyError(new Error('오늘 사용 한도를 다 썼어요. 내일 다시 이용해 주세요.')), '오늘 사용 한도를 다 썼어요. 내일 다시 이용해 주세요.');
  assert.match(friendlyError(new Error('Failed to fetch')), /인터넷/);
  assert.match(friendlyError(new Error('Missing or insufficient permissions.')), /로그인/);
});
