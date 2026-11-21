import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BackTargetState,
  getNavigationDepth,
  pickBackTarget,
} from "../src/services/navigation/backTarget.ts";

const EMPTY_STATE: BackTargetState = {
  activeCall: false,
  generatingReview: false,
  reviewFailure: false,
  initialProgressModal: false,
  prepCall: false,
  activeReview: false,
  unfinishedModal: false,
  settingsModal: false,
};

test("아무 화면도 열려 있지 않으면 null 과 깊이 0을 반환한다", () => {
  assert.equal(pickBackTarget(EMPTY_STATE), null);
  assert.equal(getNavigationDepth(EMPTY_STATE), 0);
});

test("통화 중·로딩·실패 카드·초기 진도 모달은 다른 창이 겹쳐도 닫지 않는다(복구 대상)", () => {
  const withAllClosable: BackTargetState = {
    ...EMPTY_STATE,
    prepCall: true,
    activeReview: true,
    unfinishedModal: true,
    settingsModal: true,
  };

  for (const key of [
    "activeCall",
    "generatingReview",
    "reviewFailure",
    "initialProgressModal",
  ] as const) {
    const state = { ...withAllClosable, [key]: true };
    assert.equal(pickBackTarget(state), null, `${key} 열림 시 null 이어야 함`);
    assert.equal(getNavigationDepth(state), 1, `${key} 열림 시 깊이 1이어야 함`);
  }
});

test("닫을 대상 우선순위: prepCall → 복기 모달 → 끝나지 않은 통화 모달 → 설정 모달", () => {
  assert.equal(
    pickBackTarget({
      ...EMPTY_STATE,
      prepCall: true,
      activeReview: true,
      unfinishedModal: true,
      settingsModal: true,
    }),
    "prepCall"
  );

  assert.equal(
    pickBackTarget({
      ...EMPTY_STATE,
      activeReview: true,
      unfinishedModal: true,
      settingsModal: true,
    }),
    "review"
  );

  assert.equal(
    pickBackTarget({
      ...EMPTY_STATE,
      unfinishedModal: true,
      settingsModal: true,
    }),
    "unfinished"
  );

  assert.equal(
    pickBackTarget({
      ...EMPTY_STATE,
      settingsModal: true,
    }),
    "settings"
  );
});
