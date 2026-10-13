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

  const hydratedPrompt = hydrateTutorPrompt(goal.tutorPrompt, placeholders);

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
