/**
 * Abstract Provider Interfaces (Part B-1 & B-2)
 * UI and Feature components call these interfaces rather than concrete vendor implementations.
 */

export type LiveCommand = "Done" | "Feedback" | "Model answer" | "Pause" | "Slow";

export interface LiveTranscriptItem {
  role: "user" | "model";
  text: string;
  timestamp: number;
}

export interface LiveSessionOptions {
  sessionId: string;
  systemPrompt: string;
  onAudioData: (pcmBuffer: ArrayBuffer) => void;
  onTranscript: (text: string, isUser: boolean) => void;
  onStatusChange: (
    status: "connecting" | "connected" | "reconnecting" | "closed" | "error",
    message?: string
  ) => void;
  onInterrupted?: () => void;
  onTurnComplete?: () => void;
  resumeToken?: string;
  voiceName?: string;
}

export interface LiveProvider {
  name: string;
  connect(options: LiveSessionOptions): Promise<void>;
  sendAudioChunk(pcm16kChunk: ArrayBuffer): void;
  sendTextPrompt(prompt: string): void;
  sendControlCommand(command: LiveCommand): void;
  getLiveTranscript(): LiveTranscriptItem[];
  getResumeToken(): string | null;
  getConnectionStats(): { connectionPath: "direct" | "proxy"; directFailCount: number };
  disconnect(): Promise<void>;
}

export interface SttTranscriptionOptions {
  audioBlob: Blob | ArrayBuffer;
  language?: string;
  verbatim?: boolean;
}

export interface SttResult {
  text: string;
  confidence?: number;
  engine: string;
  durationSec?: number;
}

export interface SttProvider {
  name: string;
  transcribe(options: SttTranscriptionOptions): Promise<SttResult>;
}

export interface LlmGenerateOptions {
  prompt: string;
  systemInstruction?: string;
  responseSchema?: Record<string, unknown>;
  temperature?: number;
}

export interface LlmResult<T = string> {
  content: T;
  rawResponse?: string;
  tokensUsed?: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export interface LlmProvider {
  name: string;
  generateText(options: LlmGenerateOptions): Promise<LlmResult<string>>;
  generateJson<T>(options: LlmGenerateOptions): Promise<LlmResult<T>>;
}

export interface TtsSynthesisOptions {
  text: string;
  speakerA?: string;
  speakerB?: string;
  isDialogue?: boolean;
}

export interface TtsResult {
  audioBuffer: ArrayBuffer;
  durationSec?: number;
  engine: string;
}

export interface TtsProvider {
  name: string;
  synthesize(options: TtsSynthesisOptions): Promise<TtsResult>;
}
