import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleGenAI, Session } from '@google/genai';
import { LIVE_MODEL } from '../src/config/models.ts';
import { buildLiveMemoClientContent } from '../src/services/call/correctionMemo.ts';
import { CALL_KICKOFF_PROMPT } from '../src/services/providers/geminiLiveProvider.ts';
import {
  LIVE_INPUT_AUDIO_MIME,
  buildAudioInput,
  buildDirectSetup,
  buildProxyInit,
  buildTextInput,
  buildCorrectionMemoInput,
  describeClientMessage,
  redactSocketUrl,
  validateClientMessage,
} from '../src/services/providers/liveWire.ts';

test('direct audio is byte-identical to @google/genai Session.sendRealtimeInput (mldev)', () => {
  const sent: string[] = [];
  const session = new Session(
    { send: (s: string) => sent.push(s) } as any,
    { isVertexAI: () => false } as any,
  );
  const b64 = 'AQIDBAUGBwg=';
  session.sendRealtimeInput({
    audio: { mimeType: LIVE_INPUT_AUDIO_MIME, data: b64 },
  });

  const built = buildAudioInput('direct', b64);
  assert.equal(JSON.stringify(built), sent[0]);
  assert.equal(validateClientMessage('direct', built), null);
});

test('direct text is byte-identical to Session.sendRealtimeInput({text})', () => {
  for (const text of [CALL_KICKOFF_PROMPT, '안녕하세요, 오늘 수업 시작할까요?']) {
    const sent: string[] = [];
    const session = new Session(
      { send: (s: string) => sent.push(s) } as any,
      { isVertexAI: () => false } as any,
    );
    session.sendRealtimeInput({ text });

    const built = buildTextInput('direct', text);
    assert.equal(JSON.stringify(built), sent[0]);
    assert.equal(validateClientMessage('direct', built), null);
  }
});

test('direct setup is byte-identical to SDK live.connect setup (handle 없음/있음)', async () => {
  for (const resumeHandle of [null, 'handle-resume-xyz']) {
    const sent: string[] = [];
    const ai = new GoogleGenAI({
      apiKey: 'auth_tokens/fake',
      httpOptions: { apiVersion: 'v1alpha' },
    });
    // 주의: @google/genai 의 내부 속성 webSocketFactory 에 의존한다.
    // send() 직전 시점에 session 변수가 초기화되므로 send() 안에서 setupComplete 를 돌려준다.
    (ai.live as any).webSocketFactory = {
      create(_url: string, _headers: unknown, cb: any) {
        return {
          connect() {
            cb.onopen();
          },
          send(s: string) {
            sent.push(s);
            cb.onmessage({ data: '{"setupComplete":{}}' });
          },
          close() {},
        };
      },
    };

    const systemInstruction = 'You are an English tutor.';
    const voiceName = 'Kore';

    await ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: ['AUDIO' as any],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
        systemInstruction: { parts: [{ text: systemInstruction }] },
        sessionResumption: { handle: resumeHandle || undefined },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { triggerTokens: '12000', slidingWindow: { targetTokens: '6000' } },
      },
      callbacks: {
        onmessage: () => {},
      },
    });

    const built = buildDirectSetup({
      model: LIVE_MODEL,
      voiceName,
      systemInstruction,
      resumeHandle,
    });
    assert.equal(JSON.stringify(built), sent[0]);
    assert.equal(validateClientMessage('direct', built), null);
    assert.equal(validateClientMessage('direct', JSON.parse(sent[0])), null);
  }
});

test('proxy messages match server.ts contract', () => {
  const audioMsg = buildAudioInput('proxy', 'AQID');
  assert.deepEqual(Object.keys(audioMsg), ['type', 'audio', 'mimeType']);
  assert.equal(validateClientMessage('proxy', audioMsg), null);

  const textMsg = buildTextInput('proxy', 'Hello tutor');
  assert.deepEqual(Object.keys(textMsg), ['type', 'text']);
  assert.equal(validateClientMessage('proxy', textMsg), null);

  const initMsg = buildProxyInit({
    systemInstruction: 'System prompt',
    voiceName: 'Kore',
    resumeHandle: null,
    languageCode: 'en-US',
  });
  assert.deepEqual(Object.keys(initMsg), [
    'type',
    'systemInstruction',
    'voiceName',
    'resumeHandle',
    'languageCode',
  ]);
  assert.equal(validateClientMessage('proxy', initMsg), null);
});

test('validateClientMessage(direct) rejects proxy-shaped and malformed messages', () => {
  const invalidCases: Array<{ label: string; msg: unknown }> = [
    { label: 'proxy realtime_audio', msg: { type: 'realtime_audio', audio: 'AA==', mimeType: 'audio/pcm;rate=16000' } },
    { label: 'proxy text_prompt', msg: { type: 'text_prompt', text: 'hi' } },
    { label: 'multiple top-level keys', msg: { realtimeInput: { text: 'hi' }, setup: {} } },
    { label: 'unknown top-level key', msg: { foo: {} } },
    { label: 'empty realtimeInput', msg: { realtimeInput: {} } },
    { label: 'deprecated mediaChunks', msg: { realtimeInput: { mediaChunks: [] } } },
    { label: 'non-audio mimeType', msg: { realtimeInput: { audio: { mimeType: 'video/mp4', data: '' } } } },
    { label: 'unknown realtimeInput key', msg: { realtimeInput: { type: 'x' } } },
    { label: 'null', msg: null },
    { label: 'string', msg: 'str' },
    { label: 'array', msg: [] },
  ];

  for (const { label, msg } of invalidCases) {
    const res = validateClientMessage('direct', msg);
    assert.notEqual(res, null, `expected direct validator to reject: ${label}`);
  }
});

test('validateClientMessage(proxy) rejects direct-shaped and unknown type', () => {
  assert.notEqual(validateClientMessage('proxy', { realtimeInput: { text: 'hi' } }), null);
  assert.notEqual(validateClientMessage('proxy', { setup: {} }), null);
  assert.notEqual(validateClientMessage('proxy', { type: 'bogus' }), null);

  assert.equal(
    validateClientMessage('proxy', { type: 'control_command', command: 'Done' }),
    null,
  );
  assert.equal(validateClientMessage('proxy', { type: 'interrupt' }), null);
});

test('builders cross-check: direct messages fail proxy validation and vice versa', () => {
  const directAudio = buildAudioInput('direct', 'AQID');
  const directText = buildTextInput('direct', 'hello');
  const directSetup = buildDirectSetup({
    model: LIVE_MODEL,
    voiceName: 'Kore',
    systemInstruction: 'sys',
    resumeHandle: null,
  });

  const proxyAudio = buildAudioInput('proxy', 'AQID');
  const proxyText = buildTextInput('proxy', 'hello');
  const proxyInit = buildProxyInit({
    systemInstruction: 'sys',
    voiceName: 'Kore',
    resumeHandle: null,
    languageCode: 'en-US',
  });

  assert.notEqual(validateClientMessage('proxy', directAudio), null);
  assert.notEqual(validateClientMessage('proxy', directText), null);
  assert.notEqual(validateClientMessage('proxy', directSetup), null);

  assert.notEqual(validateClientMessage('direct', proxyAudio), null);
  assert.notEqual(validateClientMessage('direct', proxyText), null);
  assert.notEqual(validateClientMessage('direct', proxyInit), null);
});

test('describeClientMessage returns key names only without payload data', () => {
  const secretBase64 = 'U0VDUkVUX0FVRElPX0RBVEE=';
  const secretPrompt = 'SENSITIVE_USER_PROMPT_TEXT';

  const dAudio = describeClientMessage(buildAudioInput('direct', secretBase64));
  const dText = describeClientMessage(buildTextInput('direct', secretPrompt));
  const dSetup = describeClientMessage(
    buildDirectSetup({
      model: LIVE_MODEL,
      voiceName: 'Kore',
      systemInstruction: secretPrompt,
      resumeHandle: 'secret-handle',
    }),
  );
  const pAudio = describeClientMessage(buildAudioInput('proxy', secretBase64));
  const pText = describeClientMessage(buildTextInput('proxy', secretPrompt));

  assert.equal(dAudio, 'realtimeInput.audio');
  assert.equal(dText, 'realtimeInput.text');
  assert.equal(dSetup, 'setup');
  assert.equal(pAudio, 'type=realtime_audio');
  assert.equal(pText, 'type=text_prompt');

  for (const desc of [dAudio, dText, dSetup, pAudio, pText]) {
    assert.equal(desc.includes(secretBase64), false);
    assert.equal(desc.includes(secretPrompt), false);
    assert.equal(desc.includes('secret-handle'), false);
  }
});

test('redactSocketUrl strips access_token and token query parameters', () => {
  const directRedacted = redactSocketUrl(
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=secret-ephemeral-value',
  );
  assert.equal(
    directRedacted,
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained',
  );
  assert.equal(directRedacted.includes('access_token'), false);
  assert.equal(directRedacted.includes('secret-ephemeral-value'), false);
  assert.equal(directRedacted.includes('?'), false);

  const proxyRedacted = redactSocketUrl(
    'wss://example.com:3000/api/gemini/live?token=secret-id-token-value',
  );
  assert.equal(proxyRedacted, 'wss://example.com:3000/api/gemini/live');
  assert.equal(proxyRedacted.includes('token'), false);
  assert.equal(proxyRedacted.includes('secret-id-token-value'), false);
  assert.equal(proxyRedacted.includes('?'), false);
});

test('buildDirectSetup omits languageCode when null/undefined and includes it when specified', () => {
  const withoutLang = buildDirectSetup({
    model: LIVE_MODEL,
    voiceName: 'Kore',
    systemInstruction: 'sys',
    resumeHandle: null,
    languageCode: null,
  }) as any;
  assert.equal('languageCode' in withoutLang.setup.generationConfig.speechConfig, false);

  const withLang = buildDirectSetup({
    model: LIVE_MODEL,
    voiceName: 'Kore',
    systemInstruction: 'sys',
    resumeHandle: null,
    languageCode: 'en-US',
  }) as any;
  assert.equal(withLang.setup.generationConfig.speechConfig.languageCode, 'en-US');
});


test('buildCorrectionMemoInput uses clientContent with turnComplete=false on both wires', () => {
  const note = '[Call corrections — do not read this aloud.]\n1. "goed" -> "went"';
  const direct = buildCorrectionMemoInput('direct', note) as any;
  assert.deepEqual(direct, {
    clientContent: {
      turns: [{ role: 'user', parts: [{ text: note }] }],
      turnComplete: false,
    },
  });
  assert.equal(validateClientMessage('direct', direct), null);

  const proxy = buildCorrectionMemoInput('proxy', note) as any;
  assert.deepEqual(proxy, { type: 'correction_memo', text: note });
  assert.equal(validateClientMessage('proxy', proxy), null);
  assert.equal(validateClientMessage('proxy', { type: 'correction_memo', text: '' }), 'invalid_proxy_correction_memo');
  assert.equal(describeClientMessage(proxy), 'type=correction_memo');
});


test('buildLiveMemoClientContent trims, rejects empty, and keeps turnComplete=false', () => {
  assert.equal(buildLiveMemoClientContent(''), null);
  assert.equal(buildLiveMemoClientContent('   '), null);
  assert.equal(buildLiveMemoClientContent(null), null);
  const note = '  1. "goed" -> "went"  ';
  assert.deepEqual(buildLiveMemoClientContent(note), {
    turns: [{ role: 'user', parts: [{ text: '1. "goed" -> "went"' }] }],
    turnComplete: false,
  });
});
