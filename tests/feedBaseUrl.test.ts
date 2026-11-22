import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicFeedBaseUrl } from '../server/feed.ts';

test('public host uses https when X-Forwarded-Proto is https', () => {
  assert.equal(
    publicFeedBaseUrl({
      forwardedProto: 'https',
      host: 'aicall.ai.studio',
      protocol: 'http',
    }),
    'https://aicall.ai.studio'
  );
});

test('public host uses https when X-Forwarded-Proto is a list starting with https', () => {
  assert.equal(
    publicFeedBaseUrl({
      forwardedProto: 'https,http',
      forwardedHost: 'aicall.ai.studio',
      protocol: 'http',
    }),
    'https://aicall.ai.studio'
  );
});

test('public host uses https from the Forwarded header', () => {
  assert.equal(
    publicFeedBaseUrl({
      forwarded: 'for=10.0.0.1;proto=https;host=aicall.ai.studio',
      host: '127.0.0.1:8080',
      protocol: 'http',
    }),
    'https://aicall.ai.studio'
  );
});

test('public host uses https even if the container saw http and no forwarded proto', () => {
  assert.equal(
    publicFeedBaseUrl({
      host: 'aicall.ai.studio',
      protocol: 'http',
    }),
    'https://aicall.ai.studio'
  );
});

test('localhost stays http when no https hint is present', () => {
  assert.equal(
    publicFeedBaseUrl({ host: 'localhost:3000', protocol: 'http' }),
    'http://localhost:3000'
  );
  assert.equal(
    publicFeedBaseUrl({ host: '127.0.0.1:3000', protocol: 'http' }),
    'http://127.0.0.1:3000'
  );
});

test('localhost uses https when the forwarded proto is https', () => {
  assert.equal(
    publicFeedBaseUrl({
      forwardedProto: 'https',
      host: 'localhost:3000',
      protocol: 'http',
    }),
    'https://localhost:3000'
  );
});
