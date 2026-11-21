/**
 * Gemini Live WebSocket 메시지 디코딩 및 순서 보장 직렬 큐(순수 모듈, DOM/Firebase 비의존).
 */

const utf8Decoder = new TextDecoder("utf-8");

export type LiveMessagePayload = string | Blob | ArrayBuffer | ArrayBufferView;

export interface SerialQueue {
  enqueue(task: () => Promise<void>): Promise<void>;
}

function isBlobLike(data: unknown): data is Blob {
  if (typeof Blob !== "undefined" && data instanceof Blob) return true;
  return typeof data === "object" && data !== null && typeof (data as Blob).text === "function";
}

/**
 * WebSocket 프레임(string | Blob | ArrayBuffer | ArrayBufferView)을 UTF-8 문자열로 푼 뒤 JSON.parse 한다.
 * 디코딩·파싱에 실패하면 Promise 가 reject 되며, 로깅과 예외 처리는 호출부가 담당한다.
 */
export async function decodeLiveMessage(data: LiveMessagePayload): Promise<any> {
  let text: string;

  if (typeof data === "string") {
    text = data;
  } else if (isBlobLike(data)) {
    text = await data.text();
  } else if (
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data) ||
    Object.prototype.toString.call(data) === "[object ArrayBuffer]"
  ) {
    text = utf8Decoder.decode(data as ArrayBuffer | ArrayBufferView);
  } else {
    throw new TypeError("지원하지 않는 Live 메시지 형식입니다.");
  }

  return JSON.parse(text);
}

/**
 * 비동기 작업(예: Blob.text() 기반 프레임 디코딩)을 들어온 순서대로 하나씩 실행한다.
 * 앞 작업이 실패해도 다음 작업은 이어서 실행되며, 오류 처리는 호출부에서 수행한다.
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue(task: () => Promise<void>): Promise<void> {
      const run = tail.then(task);
      // 앞선 작업이 reject 되어도 큐 꼬리(tail)가 끊기지 않도록 흡수한다.
      tail = run.catch(() => {});
      return run;
    },
  };
}
