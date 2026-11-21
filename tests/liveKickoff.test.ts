import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_KICKOFF_ATTEMPTS, isTutorOutput, shouldSendKickoff } from '../src/services/providers/liveKickoff.ts';

test('shouldSendKickoff truth table', () => {
  assert.equal(MAX_KICKOFF_ATTEMPTS, 2);
  assert.equal(
    shouldSendKickoff({ startedFresh: true, tutorSpoke: false, sentOnThisSocket: false, attempts: 0 }),
    true,
  );
  assert.equal(
    shouldSendKickoff({ startedFresh: true, tutorSpoke: false, sentOnThisSocket: false, attempts: 1 }),
    true,
  );
  assert.equal(
    shouldSendKickoff({
      startedFresh: true,
      tutorSpoke: false,
      sentOnThisSocket: false,
      attempts: MAX_KICKOFF_ATTEMPTS,
    }),
    false,
  );
  assert.equal(
    shouldSendKickoff({
      startedFresh: true,
      tutorSpoke: false,
      sentOnThisSocket: false,
      attempts: MAX_KICKOFF_ATTEMPTS + 1,
    }),
    false,
  );
  assert.equal(
    shouldSendKickoff({ startedFresh: false, tutorSpoke: false, sentOnThisSocket: false, attempts: 0 }),
    false,
  );
  assert.equal(
    shouldSendKickoff({ startedFresh: true, tutorSpoke: true, sentOnThisSocket: false, attempts: 0 }),
    false,
  );
  assert.equal(
    shouldSendKickoff({ startedFresh: true, tutorSpoke: false, sentOnThisSocket: true, attempts: 0 }),
    false,
  );
  assert.equal(
    shouldSendKickoff({ startedFresh: false, tutorSpoke: true, sentOnThisSocket: true, attempts: 0 }),
    false,
  );
});

test('isTutorOutput direct detects audio/text/outputTranscription and ignores control/input messages', () => {
  assert.equal(
    isTutorOutput('direct', {
      serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AQID' } }] } },
    }),
    true,
  );
  assert.equal(
    isTutorOutput('direct', {
      serverContent: { modelTurn: { parts: [{ text: 'Hello!' }] } },
    }),
    true,
  );
  assert.equal(
    isTutorOutput('direct', {
      serverContent: { outputTranscription: { text: 'Hi there!' } },
    }),
    true,
  );

  assert.equal(
    isTutorOutput('direct', {
      serverContent: { inputTranscription: { text: 'Hello' } },
    }),
    false,
  );
  assert.equal(isTutorOutput('direct', { setupComplete: {} }), false);
  assert.equal(
    isTutorOutput('direct', { sessionResumptionUpdate: { newHandle: 'h-1' } }),
    false,
  );
  assert.equal(isTutorOutput('direct', { goAway: { timeLimit: '5s' } }), false);
  assert.equal(
    isTutorOutput('direct', { serverContent: { turnComplete: true } }),
    false,
  );
});

test('isTutorOutput proxy detects audio/output_transcript/text and ignores control/input messages', () => {
  assert.equal(isTutorOutput('proxy', { type: 'audio', audio: 'AQID' }), true);
  assert.equal(
    isTutorOutput('proxy', { type: 'output_transcript', text: 'Hi!' }),
    true,
  );
  assert.equal(isTutorOutput('proxy', { type: 'text', text: 'Hi!' }), true);

  assert.equal(
    isTutorOutput('proxy', { type: 'input_transcript', text: 'Hello' }),
    false,
  );
  assert.equal(isTutorOutput('proxy', { type: 'turnComplete' }), false);
  assert.equal(isTutorOutput('proxy', { type: 'go_away' }), false);
  assert.equal(
    isTutorOutput('proxy', { type: 'session_resumption_update', handle: 'h-1' }),
    false,
  );
  assert.equal(isTutorOutput('proxy', { type: 'ready' }), false);
});
