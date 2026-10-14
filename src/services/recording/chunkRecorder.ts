/**
 * B-3 Background 10-Second Audio Chunk Recorder
 * 
 * - Records continuous 10-second audio segments via MediaRecorder.
 * - Saves each chunk immediately to IndexedDB before upload.
 * - Uploads immediately to Cloud Storage, deleting from IndexedDB upon success.
 * - Runs independently of Live connection state (continues during reconnects/GoAway/proxy fallback).
 * - Triggers 1-minute asynchronous partial transcription via gemini-3.5-transcribe VERBATIM.
 */

import {
  saveChunkLocally,
  deleteChunkLocally,
  LocalRecordingChunk,
} from "./chunkIndexedDb";
import { uploadAudioFile } from "../firebase/storage";
import {
  appendSessionChunk,
  appendSessionSttPartial,
  RecordingChunkMeta,
  SttPartialItem,
} from "../firebase/db";
import { authFetch } from "../api/authFetch";
import { mergeChunksToWav } from "./audioMerge";

export interface ChunkRecorderOptions {
  userId: string;
  sessionId: string;
  enablePartialTranscribe?: boolean;
  onChunkRecorded?: (chunk: RecordingChunkMeta) => void;
  onPartialStt?: (stt: SttPartialItem) => void;
  onError?: (err: Error) => void;
}

export class ChunkRecorder {
  private stream: MediaStream | null = null;
  private currentRecorder: MediaRecorder | null = null;
  private isRunning: boolean = false;
  private chunkIndex: number = 0;
  private options: ChunkRecorderOptions | null = null;
  private segmentTimer: NodeJS.Timeout | null = null;
  private accumulatedBlobsForMinute: Blob[] = [];
  private accumulatedChunkIndices: number[] = [];
  private minuteBatchIndex: number = 0;
  private mimeType: string = "audio/webm";
  private sessionRecordedBlobs: Blob[] = [];

  constructor() {
    // Detect preferred audio mimeType
    if (typeof MediaRecorder !== "undefined") {
      if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        this.mimeType = "audio/webm;codecs=opus";
      } else if (MediaRecorder.isTypeSupported("audio/webm")) {
        this.mimeType = "audio/webm";
      } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
        this.mimeType = "audio/mp4";
      } else if (MediaRecorder.isTypeSupported("audio/ogg")) {
        this.mimeType = "audio/ogg";
      }
    }
  }

  /**
   * Start 10-second chunk recording using a clone of the microphone stream
   */
  public async start(stream: MediaStream, options: ChunkRecorderOptions): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    this.options = options;
    this.chunkIndex = 0;
    this.minuteBatchIndex = 0;
    this.accumulatedBlobsForMinute = [];
    this.accumulatedChunkIndices = [];
    this.sessionRecordedBlobs = [];

    // Clone audio tracks so that Live reconnects/cleanups don't stop our background recording
    const audioTracks = stream.getAudioTracks().map((track) => track.clone());
    this.stream = new MediaStream(audioTracks);

    console.log(`[ChunkRecorder] Starting 10-second chunk recording for session ${options.sessionId} (${this.mimeType})`);
    this.recordNextSegment();
  }

  /**
   * Stop chunk recording and flush active chunk
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.segmentTimer) {
      clearTimeout(this.segmentTimer);
      this.segmentTimer = null;
    }

    if (this.currentRecorder && this.currentRecorder.state !== "inactive") {
      try {
        this.currentRecorder.stop();
      } catch {
        // ignore
      }
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    console.log("[ChunkRecorder] Stopped 10-second chunk recording.");
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public getChunkCount(): number {
    return this.chunkIndex;
  }

  public getSessionRecordedBlobs(): Blob[] {
    return [...this.sessionRecordedBlobs];
  }

  public getMimeType(): string {
    return this.mimeType;
  }

  private recordNextSegment(): void {
    if (!this.isRunning || !this.stream) return;

    // Check if audio tracks are still active
    const activeTracks = this.stream.getAudioTracks().filter((t) => t.readyState === "live");
    if (activeTracks.length === 0) {
      console.warn("[ChunkRecorder] No active audio tracks available to record chunk.");
      return;
    }

    const currentIdx = this.chunkIndex++;
    const chunks: Blob[] = [];

    try {
      const recorder = new MediaRecorder(this.stream, { mimeType: this.mimeType });
      this.currentRecorder = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onstop = async () => {
        if (chunks.length > 0) {
          const finalBlob = new Blob(chunks, { type: this.mimeType });
          this.processChunk(currentIdx, finalBlob);
        }

        // Loop to next segment if still running
        if (this.isRunning) {
          this.recordNextSegment();
        }
      };

      recorder.start();

      // Stop recorder after exactly 10 seconds to generate a complete standalone chunk
      this.segmentTimer = setTimeout(() => {
        if (recorder.state === "recording") {
          recorder.stop();
        }
      }, 10000);
    } catch (err: any) {
      console.error("[ChunkRecorder] Error recording 10-second segment:", err);
      this.options?.onError?.(err instanceof Error ? err : new Error(String(err)));
      if (this.isRunning) {
        // Retry in 2 seconds
        this.segmentTimer = setTimeout(() => this.recordNextSegment(), 2000);
      }
    }
  }

  /**
   * Process a 10s chunk:
   * 1. Save to IndexedDB
   * 2. Upload to Cloud Storage
   * 3. On success: delete from IndexedDB & append to session doc in Firestore
   * 4. Check if 1-minute batch is ready for async gemini-3.5-transcribe VERBATIM
   */
  private async processChunk(index: number, blob: Blob): Promise<void> {
    if (!this.options) return;
    const { userId, sessionId } = this.options;
    this.sessionRecordedBlobs.push(blob);
    const timestamp = Date.now();
    const chunkId = `${sessionId}_chunk_${index}`;
    const storagePath = `recordings/${sessionId}/chunk_${String(index).padStart(4, "0")}_${timestamp}.webm`;

    const localChunk: LocalRecordingChunk = {
      id: chunkId,
      sessionId,
      userId,
      index,
      blob,
      mimeType: this.mimeType,
      durationSeconds: 10,
      timestamp,
      createdAt: new Date(timestamp).toISOString(),
      uploaded: false,
    };

    // 1) Save to IndexedDB first (guarantees persistence across crashes)
    await saveChunkLocally(localChunk);

    // 2) Upload to Cloud Storage
    let storageUrl: string | undefined;
    let uploadedSuccessfully = false;

    try {
      storageUrl = await uploadAudioFile(userId, storagePath, blob);
      uploadedSuccessfully = true;

      // 3) Once uploaded, remove from IndexedDB
      await deleteChunkLocally(chunkId);
    } catch (uploadErr: any) {
      console.warn(`[ChunkRecorder] Chunk ${index} upload failed, retained in IndexedDB for retry:`, uploadErr);
    }

    // 4) Record metadata in Firestore session document
    const chunkMeta: RecordingChunkMeta = {
      index,
      path: storagePath,
      storageUrl,
      timestamp: new Date(timestamp).toISOString(),
      uploaded: uploadedSuccessfully,
      durationSeconds: 10,
      sizeBytes: blob.size,
    };

    try {
      await appendSessionChunk(userId, sessionId, chunkMeta);
    } catch (dbErr) {
      console.warn("[ChunkRecorder] Failed to append chunk metadata to Firestore:", dbErr);
    }

    this.options.onChunkRecorded?.(chunkMeta);

    // 5) Accumulate chunks for 1-minute partial transcription
    this.accumulatedBlobsForMinute.push(blob);
    this.accumulatedChunkIndices.push(index);

    // 6 chunks = 60 seconds
    if (this.accumulatedBlobsForMinute.length >= 6) {
      const blobsToTranscribe = [...this.accumulatedBlobsForMinute];
      const indicesToTranscribe = [...this.accumulatedChunkIndices];
      const minuteIdx = this.minuteBatchIndex++;

      this.accumulatedBlobsForMinute = [];
      this.accumulatedChunkIndices = [];

      if (this.options.enablePartialTranscribe !== false) {
        this.triggerPartialTranscription(minuteIdx, blobsToTranscribe, indicesToTranscribe);
      }
    }
  }

  /**
   * Asynchronous 1-minute partial transcription via gemini-3.5-transcribe VERBATIM
   */
  private async triggerPartialTranscription(
    minuteIndex: number,
    blobs: Blob[],
    chunkIndices: number[]
  ): Promise<void> {
    if (!this.options) return;
    const { userId, sessionId } = this.options;

    const startMin = minuteIndex;
    const endMin = minuteIndex + 1;
    const timeRange = `${String(startMin).padStart(2, "0")}:00 - ${String(endMin).padStart(2, "0")}:00`;

    try {
      // Combine 6 standalone chunks into one 1-minute WAV (byte-joining WebM files loses audio)
      const merged = await mergeChunksToWav(blobs);
      const combinedBlob = merged ? merged.wav : new Blob(blobs, { type: this.mimeType });
      const base64Audio = await this.blobToBase64(combinedBlob);

      console.log(`[ChunkRecorder] Requesting 1-min partial transcribe for ${timeRange} (${blobs.length} chunks)`);

      const response = await authFetch("/api/gemini/transcribe-partial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          userId,
          minuteIndex,
          timeRange,
          audioBase64: base64Audio,
          mimeType: combinedBlob.type || this.mimeType,
        }),
      });

      if (!response.ok) {
        throw new Error(`Transcribe endpoint returned HTTP ${response.status}`);
      }

      const data = await response.json();
      if (data.ok && typeof data.transcript === "string") {
        const sttItem: SttPartialItem = {
          minuteIndex,
          timeRange,
          transcript: data.transcript.trim(),
          timestamp: new Date().toISOString(),
          sourceChunkIndices: chunkIndices,
        };

        // Append to Firestore sessions.sttPartial
        await appendSessionSttPartial(userId, sessionId, sttItem);
        this.options.onPartialStt?.(sttItem);
        console.log(`[ChunkRecorder] 1-min partial transcribe complete for ${timeRange}: "${sttItem.transcript.slice(0, 40)}..."`);
      }
    } catch (err) {
      console.warn(`[ChunkRecorder] 1-min partial transcribe for ${timeRange} skipped or failed:`, err);
    }
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        const base64 = result.includes(",") ? result.split(",")[1] : result;
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}

// Singleton recorder instance
let activeRecorderInstance: ChunkRecorder | null = null;

export function getChunkRecorder(): ChunkRecorder {
  if (!activeRecorderInstance) {
    activeRecorderInstance = new ChunkRecorder();
  }
  return activeRecorderInstance;
}
