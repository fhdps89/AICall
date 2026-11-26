export const ADVANCED_TOGGLE_TEXT = { show: "고급 설정 보기", hide: "고급 설정 숨기기" } as const;
export const KEY_TAB_LABEL = "연결 키";
export const PARTIAL_TRANSCRIBE_DESCRIPTION =
  "기본값: 꺼짐. 꺼져 있어도 10초 단위 오디오 자동 백업과 통화 종료 후 최종 받아쓰기는 정상 동작합니다. 켜면 통화 중 1분마다 임시 텍스트를 추가로 만들어 받아쓰기 비용이 약 2배가 됩니다.";
export const CALL_ENGINE_POC_TITLE = "시험 통화 엔진: 구글 스트리밍 (테스트)";
export const CALL_ENGINE_POC_DESCRIPTION =
  "기본값: 꺼짐. 켜면 다음 통화부터 이 기기에서만 받아쓰기·답변·음성을 따로 처리하는 시험 엔진으로 연결합니다(통화 화면에 「시험 모드」 표시). 8초 안에 연결되지 않으면 자동으로 기본 엔진으로 연결합니다. 비용은 사용량 탭의 「시험 통화 비용 A」·「시험 통화 비용 B」에 답변 모델별로 따로 쌓입니다.";
export const POC_TEXT_VARIANT_TITLE = "시험 엔진 답변 모델 (A/B 비교)";
export const POC_TEXT_VARIANT_DESCRIPTION =
  "기본값: A. 이 기기에만 저장됩니다. 주소에 ?pocText=a 또는 ?pocText=b를 붙이면 그 페이지에서만 이 설정 대신 그 값을 씁니다(잘못된 값은 A).";
