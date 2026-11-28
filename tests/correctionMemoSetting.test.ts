import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CORRECTION_MEMO_KEY,
  isCorrectionMemoEnabled,
  parseCorrectionMemoParam,
  setCorrectionMemoEnabled,
} from "../src/services/settings/correctionMemoSetting.ts";

function memoryStore(init: Record<string, string> = {}) {
  const data = { ...init };
  return {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    data,
  };
}

test("parseCorrectionMemoParam reads on/off aliases and ignores junk", () => {
  assert.equal(parseCorrectionMemoParam("?correctionMemo=off"), "off");
  assert.equal(parseCorrectionMemoParam("correctionMemo=0"), "off");
  assert.equal(parseCorrectionMemoParam("?foo=1&correctionMemo=false"), "off");
  assert.equal(parseCorrectionMemoParam("?correctionMemo=on"), "on");
  assert.equal(parseCorrectionMemoParam("?correctionMemo=TRUE"), "on");
  assert.equal(parseCorrectionMemoParam("?qa=1"), null);
  assert.equal(parseCorrectionMemoParam("?correctionMemo=maybe"), null);
});

test("default is ON; stored false turns it off; URL wins and is not written back", () => {
  const s = memoryStore();
  assert.equal(isCorrectionMemoEnabled(s, ""), true);
  setCorrectionMemoEnabled(false, s);
  assert.equal(s.data[CORRECTION_MEMO_KEY], "false");
  assert.equal(isCorrectionMemoEnabled(s, ""), false);
  assert.equal(isCorrectionMemoEnabled(s, "?correctionMemo=on"), true);
  assert.equal(s.data[CORRECTION_MEMO_KEY], "false");
  setCorrectionMemoEnabled(true, s);
  assert.equal(isCorrectionMemoEnabled(s, ""), true);
  assert.equal(isCorrectionMemoEnabled(s, "?correctionMemo=off"), false);
  assert.equal(isCorrectionMemoEnabled(null, ""), true);
});
