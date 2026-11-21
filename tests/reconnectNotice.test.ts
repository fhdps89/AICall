import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECONNECT_NOTICE_DELAY_MS,
  reconnectNoticeRemainingMs,
  resolveReconnectUiState,
  shouldShowReconnectNotice,
} from '../src/ui/call/reconnectNotice.ts';

test('shouldShowReconnectNotice hides banner when not reconnecting or before delay', () => {
  assert.equal(RECONNECT_NOTICE_DELAY_MS, 1500);
  assert.equal(
    shouldShowReconnectNotice({
      status: 'connected',
      reconnectingSinceMs: 0,
      nowMs: 5000,
    }),
    false,
  );
  assert.equal(
    shouldShowReconnectNotice({
      status: 'connecting',
      reconnectingSinceMs: 0,
      nowMs: 5000,
    }),
    false,
  );
  assert.equal(
    shouldShowReconnectNotice({
      status: 'reconnecting',
      reconnectingSinceMs: null,
      nowMs: 5000,
    }),
    false,
  );
  assert.equal(
    shouldShowReconnectNotice({
      status: 'reconnecting',
      reconnectingSinceMs: 0,
      nowMs: 1499,
    }),
    false,
  );
  assert.equal(
    shouldShowReconnectNotice({
      status: 'reconnecting',
      reconnectingSinceMs: 0,
      nowMs: 1500,
    }),
    true,
  );
});

test('reconnectNoticeRemainingMs computes remaining milliseconds clamped at 0', () => {
  assert.equal(
    reconnectNoticeRemainingMs({ reconnectingSinceMs: 0, nowMs: 400 }),
    1100,
  );
  assert.equal(
    reconnectNoticeRemainingMs({ reconnectingSinceMs: 0, nowMs: 2000 }),
    0,
  );
});

test('resolveReconnectUiState uses timer-driven noticeVisible without clock boundary drift', () => {
  // 재연결 진입 직후(타이머 만료 전): 배너 숨김 + 표시 상태는 connected 유지
  assert.deepEqual(
    resolveReconnectUiState({ status: 'reconnecting', noticeVisible: false }),
    { showReconnectNotice: false, displayStatus: 'connected' },
  );

  // 1500ms 타이머 콜백이 noticeVisible=true 를 켠 뒤: 즉시 배너 노출 + reconnecting 표시
  assert.deepEqual(
    resolveReconnectUiState({ status: 'reconnecting', noticeVisible: true }),
    { showReconnectNotice: true, displayStatus: 'reconnecting' },
  );

  // 재연결이 끝난 뒤에는 noticeVisible 이 true 로 남아있는 렌더에서도 배너 숨김
  for (const status of ['connecting', 'connected', 'closed', 'error'] as const) {
    assert.deepEqual(resolveReconnectUiState({ status, noticeVisible: true }), {
      showReconnectNotice: false,
      displayStatus: status,
    });
  }
});
