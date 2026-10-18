export interface PromptPlaceholders {
  job: string;
  surveyTopics: string;
  phillyRole: string;
  opicWeakPoints: string;
  phillyWeakPoints: string;
  travelWeakPoints: string;
}

export const DEFAULT_PROMPT_PLACEHOLDERS: PromptPlaceholders = {
  job: "조선해양 생산관리 엔지니어",
  surveyTopics: "영화보기, 공원가기, 국내여행, 해외여행, 조깅",
  phillyRole: "production planning engineer",
  opicWeakPoints: "none yet",
  phillyWeakPoints: "none yet",
  travelWeakPoints: "none yet",
};

/**
 * Hydrates verbatim tutor prompt by replacing custom user placeholders
 * The original prompt in storage remains untouched.
 */
export function hydrateTutorPrompt(
  rawPrompt: string,
  placeholders: Partial<PromptPlaceholders> = {},
  goalId?: string
): string {
  const merged = { ...DEFAULT_PROMPT_PLACEHOLDERS, ...placeholders };

  let hydrated = rawPrompt;

  // Replace [직무]
  hydrated = hydrated.replace(/\[직무\]/g, merged.job);

  // Replace [예: watching movies, going to parks, domestic travel, overseas travel, jogging]
  hydrated = hydrated.replace(
    /\[예:\s*watching movies,\s*going to parks,\s*domestic travel,\s*overseas travel,\s*jogging\]/g,
    merged.surveyTopics
  );

  // Replace [예: production planning engineer / QA / procurement / project management]
  hydrated = hydrated.replace(
    /\[예:\s*production planning engineer\s*\/\s*QA\s*\/\s*procurement\s*\/\s*project management\]/g,
    merged.phillyRole
  );

  // Replace [복기 프롬프트 결과의 3줄. 처음이면 "none yet"]
  hydrated = hydrated.replace(
    /\[복기 프롬프트 결과의 3줄\.\s*처음이면 "none yet"\]/g,
    merged.opicWeakPoints
  );

  // Replace [복기 프롬프트 결과 3줄 또는 "none yet"] (used by both the Philly and Travel prompts)
  hydrated = hydrated.replace(
    /\[복기 프롬프트 결과 3줄 또는 "none yet"\]/g,
    goalId === "travel" ? merged.travelWeakPoints : merged.phillyWeakPoints
  );

  return hydrated;
}
