import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QA_KEY,
  parseQaParam,
  applyQaParam,
  readQaMode,
  resolveMistakeSource,
  type QaStore,
} from '../src/data/qaMode.ts';

function memStore(init: Record<string, string> = {}): QaStore & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

test('parseQaParam: qa=1 on, qa=0 off, other null', () => {
  assert.equal(parseQaParam('?qa=1'), 'on');
  assert.equal(parseQaParam('qa=1'), 'on');
  assert.equal(parseQaParam('?qa=0'), 'off');
  assert.equal(parseQaParam(''), null);
  assert.equal(parseQaParam('?qa=yes'), null);
  assert.equal(parseQaParam('?x=1'), null);
});

test('applyQaParam persists and survives a later empty search', () => {
  const store = memStore();
  assert.equal(applyQaParam('?qa=1', store), true);
  assert.equal(store.data[QA_KEY], '1');
  assert.equal(applyQaParam('', store), true);
  assert.equal(applyQaParam('?qa=0', store), false);
  assert.equal(store.data[QA_KEY], undefined);
});

test('readQaMode is false when storage is missing or throws', () => {
  assert.equal(readQaMode(undefined), false);
  const throwing: QaStore = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(readQaMode(throwing), false);
  assert.equal(applyQaParam('?qa=1', throwing), false);
});

test('resolveMistakeSource: session wins; missing session falls back to current flag', () => {
  assert.equal(resolveMistakeSource({ source: 'qa' }, false), 'qa');
  assert.equal(resolveMistakeSource({}, true), 'call');
  assert.equal(resolveMistakeSource(null, true), 'qa');
  assert.equal(resolveMistakeSource(null, false), 'call');
  assert.equal(resolveMistakeSource(undefined, true), 'qa');
});
