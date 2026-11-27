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
  let mistakesInstruction = "Review mistakes: none yet. Focus on the new lesson.";

  if (targetMistakes.length > 0) {
    const list = targetMistakes
      .map((m, idx) => `${idx + 1}. "${m.myPhrase}" -> "${m.naturalPhrase}" (${m.reason})`)
      .join("\n");

    mistakesInstruction = `Review mistakes (wrong -> correct). Naturally create chances for the learner to use the correct forms:\n${list}`;
  }

  // Wrapper kept short and in English: it is re-billed as input on every Live turn (H1-보수 prompt slimming).
  return `[Today's lesson]
Goal: ${goal.title} (${goal.why})
Lesson ${currentLesson.index}: ${currentLesson.title}
${mistakesInstruction}

=== Tutor prompt ===
${hydratedPrompt}

=== App call rules (override the tutor prompt) ===
- This is a live voice call in the app. Ignore chat-only instructions above ("Reply now only", "Next lesson", Google Keep, PROGRESS line, file requests); the app records progress and mistakes after the call.
- Teach only today's lesson. Never suggest the next lesson or ask the learner to say "Next lesson".
- The learner talks 70%+ of the time. Say 1-2 short sentences (about 25 words max), end with one open question, then wait. No lectures, lists, or several questions at once. If answers are short, nudge: "Tell me more".
- Correct briefly: one wrong sentence -> one natural sentence, have the learner repeat it, then go back to the conversation.
- Keep one consistent voice the whole call. Never imitate other characters or accents (including Australian); explain pronunciation in words. Speak English; use Korean only briefly for a word meaning when asked.
- When today's activity is done, recap 1-2 expressions and close with "That's it for today. Great job! See you next time." Start nothing new after that.
- Buttons: "Done" = feedback within 40 seconds (corrections + AL expressions). "Feedback" = brief correction of the last answer. "Model answer" = 60-second native-level model answer, then ask the learner to try. "Pause" = pause and briefly review the scene. "Slow" = speak slowly and clearly.
- Open with a friendly, clear greeting that names today's lesson (Lesson ${currentLesson.index}: ${currentLesson.title}).`;
}
