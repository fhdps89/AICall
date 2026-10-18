import { GoalData } from "../services/firebase/db";
import { PromptPlaceholders, hydrateTutorPrompt } from "./promptCustomizer";

export interface ReviewMistakeItem {
  id?: string;
  myPhrase: string;
  naturalPhrase: string;
  reason: string;
}

/**
 * Builds the "오늘 수업 지시서" system prompt for Gemini Live (B-2 requirement 4)
 * Contains:
 * - Goal & lesson information
 * - Verbatim tutor prompt with user placeholders hydrated
 * - Up to 3 review target mistakes (instructing the tutor to naturally prompt the user to use them)
 */
export function buildTodayLessonSystemPrompt(
  goal: GoalData,
  lessonIndex: number,
  placeholders: PromptPlaceholders,
  reviewMistakes: ReviewMistakeItem[] = []
): string {
  const currentLesson = goal.lessons.find((l) => l.index === lessonIndex) || {
    index: lessonIndex,
    title: `Lesson ${lessonIndex}`,
  };

  const hydratedPrompt = hydrateTutorPrompt(goal.tutorPrompt, placeholders, goal.id);

  // Take up to 3 review mistakes
  const targetMistakes = reviewMistakes.slice(0, 3);
  let mistakesInstruction = "복습 대상 실수: 아직 등록된 실수가 없습니다 (새 수업에 집중하세요).";

  if (targetMistakes.length > 0) {
    const list = targetMistakes
      .map(
        (m, idx) =>
          `  ${idx + 1}. 틀렸던 표현: "${m.myPhrase}" ➔ 올바른 표현: "${m.naturalPhrase}" (${m.reason})`
      )
      .join("\n");

    mistakesInstruction = `복습 대상 실수 (최대 3개 - 대화 중 이 표현을 쓸 상황을 자연스럽게 유도해 주세요):\n${list}`;
  }

  return `[오늘 수업 지시서]
목표: ${goal.title} (${goal.why})
오늘 진행할 과: ${currentLesson.index}과. ${currentLesson.title}

${mistakesInstruction}

================ 튜터 규칙 및 페르소나 지시문 ================
${hydratedPrompt}

================ 앱 통화 규칙 (위 지시문과 다르면 이 규칙이 우선) ================
- 이 통화는 One Call English 앱 안의 음성 통화입니다. 위 지시문의 채팅용 안내("Reply now only", "Next lesson", Google Keep 확인, PROGRESS 줄, 파일 첨부 요청)는 따르지 마세요. 과 진도와 실수 기록은 앱이 통화 뒤에 자동으로 처리합니다.
- 오늘은 위에 적힌 과 하나만 진행합니다. 다음 과를 제안하거나 "Next lesson"이라고 말하라고 하지 마세요.
- 학습자가 더 많이 말해야 합니다(학습자 70% 이상). 한 번에 1~2문장(대략 25단어 이하)만 말하고, 열린 질문 하나로 끝낸 뒤 기다리세요. 긴 설명·목록·여러 질문을 한꺼번에 하지 마세요. 학습자의 답이 짧으면 "Tell me more"처럼 더 말하게 유도하세요.
- 교정은 짧게: 틀린 문장 하나 → 자연스러운 문장 하나, 따라 말하게 한 뒤 바로 대화로 돌아가세요.
- 목소리는 처음부터 끝까지 한 사람의 같은 목소리로 유지하세요. 다른 인물·억양(호주 억양 포함)을 흉내 내거나 목소리를 바꾸지 말고, 발음 차이는 말로 설명하세요. 기본은 영어로 말하고, 한국어는 학습자가 요청할 때 단어 뜻 정도로만 짧게 쓰세요.
- 오늘 과의 활동이 끝나면 오늘 배운 표현 1~2개만 짧게 짚고 "That's it for today. Great job! See you next time."처럼 인사하며 마무리하세요. 마무리 뒤에는 새 활동을 시작하지 마세요.

================ 실시간 통화 추가 지침 ================
- 현재는 실시간 음성 통화 모드입니다. 답변은 구어체로 간결하고 친절하게 대화해 주세요.
- 학습자가 화면의 버튼으로 다음 명령을 보낼 수 있습니다:
  - "Done": 학습자가 답변을 마침. 40초 이내로 핵심 피드백(잘못된 부분 교정 및 AL 표현)을 주세요.
  - "Feedback": 즉시 피드백 요청. 방금 발화에 대해 간결하게 교정해 주세요.
  - "Model answer": 원어민 수준의 60초 모범 답안을 들려주고 따라 말해보게 유도하세요.
  - "Pause": 대화를 잠시 멈추고 방금 장면에 대해 짧게 점검하세요.
  - "Slow": 속도를 늦춰 천천히 또박또박 말해 주세요.
- 첫 마디는 친절하고 명확하게 오늘 과(${currentLesson.index}과. ${currentLesson.title})의 시작을 알리는 인사로 시작해 주세요.`;
}
