import { TrackConfig, TrackId } from '../types';

export const TRACK_CONFIGS: Record<TrackId, TrackConfig> = {
  opic: {
    id: 'opic',
    name: '🎯 OPIc 코치',
    shortName: 'OPIc AL',
    emoji: '🎯',
    accentColor: '#10B981', // emerald
    tagline: 'OPIc AL 달성을 위한 1:1 집중 스피킹 코칭',
    personaTitle: 'OPIc Speaking Coach',
    accentVoice: 'Kore',
    systemPrompt: `You are my OPIc speaking coach. Goal: AL (Advanced Low).
We will continue this chat in voice mode. Follow these rules for the whole session:

ABOUT ME:
- Job: works at a shipbuilding company; will be posted to Hanwha Philly Shipyard in Philadelphia.
- Family: has a young child; we watch cartoons like Bluey together.
- Survey topics I chose: watching movies, going to parks, domestic travel, overseas travel, jogging.

FORMAT:
- Mode: PRACTICE by default. ("Exam mode" switches to EXAM).
- For each topic ask in this order: description → routine → past experience with details → comparison/change over time. Mix in role-plays and social issue questions.
- Ask one question at a time, then stop and wait.

WHILE I ANSWER:
- Answers may be 1-2 minutes with pauses. Do not interrupt or react until I say "Done". If I pause, stay silent.

AFTER "Done" (PRACTICE only, under 40 seconds):
1. Estimated level for this answer (IM2 / IH / AL).
2. Top 2 errors: my sentence -> corrected sentence (tense, articles, prepositions, word choice).
3. One AL upgrade expression I should have used.
4. Ask: "Try again, or next question?"
No generic praise. Keep it crisp and focused.

If I say "Model answer", give a 60-second AL answer to the same question using my details, then invite me to try it in my own words.`,
    lessons: [
      {
        id: 'opic-1',
        lessonNum: 1,
        title: '자기소개',
        subtitle: '직무, 필라델피아 파견 예정, 가족 소개',
        targetMinutes: 30,
        starterPrompt: 'Lesson 1: Self-introduction (job, Philadelphia posting, family). Let us begin with your background.',
        keyGoals: ['자연스러운 시제 사용', '업무와 가족 배경 소개', 'AL 수준의 서론 전개'],
      },
      {
        id: 'opic-2',
        lessonNum: 2,
        title: '집 묘사 · 습관 · 변화',
        subtitle: '집 구조 묘사, 일상 루틴, 과거와의 차이점',
        targetMinutes: 30,
        starterPrompt: 'Lesson 2: Describe your home, your routine at home, and how your living space has changed over time.',
        keyGoals: ['공간 묘사 어휘', '현재완료/과거 시제 대비', '디테일한 형용사 활용'],
      },
      {
        id: 'opic-3',
        lessonNum: 3,
        title: '동네 묘사 & 기억에 남는 경험',
        subtitle: '우리 동네 편의시설, 산책로, 특별했던 일화',
        targetMinutes: 30,
        starterPrompt: 'Lesson 3: Describe your neighborhood, what you usually do there, and a memorable experience you had.',
        keyGoals: ['동네 지형 및 시설 묘사', '과거 에피소드 스토리텔링', '시간 순서 접속사'],
      },
      {
        id: 'opic-4',
        lessonNum: 4,
        title: '설문 주제 1: 영화 관람',
        subtitle: '선호 장르, 영화관 루틴, 가장 인상적인 영화',
        targetMinutes: 30,
        starterPrompt: 'Lesson 4: Watching movies - favorite genres, your routine when visiting a cinema, and a memorable movie you watched.',
        keyGoals: ['감정 및 플롯 표현', '비교 표현', '구체적인 리뷰 표현'],
      },
      {
        id: 'opic-5',
        lessonNum: 5,
        title: '설문 주제 2: 공원 가기 & 조깅',
        subtitle: '자주 찾는 공원, 운동 습관, 계절별 풍경',
        targetMinutes: 30,
        starterPrompt: 'Lesson 5: Going to parks and jogging - routines, equipment, seasonal changes, and an unexpected encounter.',
        keyGoals: ['운동 관련 어휘', '환경 묘사', '돌발 상황 대처 표현'],
      },
      {
        id: 'opic-6',
        lessonNum: 6,
        title: '설문 주제 3: 음악 감상',
        subtitle: '좋아하는 가수, 라이브 공연 경험, 음악 취향 변화',
        targetMinutes: 30,
        starterPrompt: 'Lesson 6: Music listening - favorite artists, live concerts, and how your music tastes have evolved over time.',
        keyGoals: ['취향 변화 설명', '감상평', '과거 콘서트 에피소드'],
      },
      {
        id: 'opic-7',
        lessonNum: 7,
        title: '국내 여행 경험',
        subtitle: '가장 좋아하는 국내 여행지, 준비 과정, 문제 상황',
        targetMinutes: 30,
        starterPrompt: 'Lesson 7: Domestic travel - your favorite destination in Korea, how you prepare, and a trip that had an unexpected problem.',
        keyGoals: ['여행 일정 묘사', '문제가 발생한 순간 서술', '해결 과정'],
      },
      {
        id: 'opic-8',
        lessonNum: 8,
        title: '해외 여행 경험',
        subtitle: '방문했던 국가, 한국과의 문화 차이 비교',
        targetMinutes: 30,
        starterPrompt: 'Lesson 8: Overseas travel - a foreign country you visited, comparisons with Korea, and an unforgettable story.',
        keyGoals: ['문화 차이 대조 표현', 'AL급 복합문 구사', '생생한 디테일'],
      },
      {
        id: 'opic-9',
        lessonNum: 9,
        title: '롤플레이 A: 질문하기',
        subtitle: '전화로 상대방의 계획이나 상품에 대해 3~4가지 질문',
        targetMinutes: 30,
        starterPrompt: 'Lesson 9: Role-play A - Call me to ask 3-4 detailed questions about a travel package or product you want to buy.',
        keyGoals: ['공손한 질문 형식', 'Can/Could/Would 활용', '추가 정보 재확인'],
      },
      {
        id: 'opic-10',
        lessonNum: 10,
        title: '롤플레이 B: 문제 해결 및 대안 제시',
        subtitle: '예약 취소/물품 파손 문제 설명 및 2가지 대안 제안',
        targetMinutes: 30,
        starterPrompt: 'Lesson 10: Role-play B - You booked a hotel room or flight, but there is a problem. Explain the situation and offer two reasonable alternatives.',
        keyGoals: ['문제 상황 명확한 설명', '대안 제시 (Alternative options)', '설득력 있는 어조'],
      },
      {
        id: 'opic-11',
        lessonNum: 11,
        title: '롤플레이 C: 비슷한 과거 경험',
        subtitle: '과거에 겪었던 유사한 예약 취소나 문제 해결 경험',
        targetMinutes: 30,
        starterPrompt: 'Lesson 11: Role-play C - Tell me about a real past experience when you faced a similar cancellation or booking issue and how you resolved it.',
        keyGoals: ['위기 해결 스토리텔링', '과거완료 시제', '교훈 및 소감'],
      },
      {
        id: 'opic-12',
        lessonNum: 12,
        title: '돌발 주제: IT 기기 · 날씨 · 재활용',
        subtitle: '예상치 못한 주제에 대한 침착한 전개와 어휘',
        targetMinutes: 30,
        starterPrompt: 'Lesson 12: Unexpected topic - Smartphones/technology, recycling regulations in Korea, or sudden weather changes.',
        keyGoals: ['순발력 있는 서론', '사회적 트렌드 설명', '일관된 논리 유지'],
      },
      {
        id: 'opic-13',
        lessonNum: 13,
        title: '사회 이슈 & 과거와 현재의 비교',
        subtitle: '주거 형태, 여행 방식의 기술적 변화와 트렌드',
        targetMinutes: 30,
        starterPrompt: 'Lesson 13: Social issues and comparisons - How the housing market or travel habits have shifted compared to 10-20 years ago.',
        keyGoals: ['거시적 관점 비교', '고급 접속사(whereas, unlike in the past)', 'AL 등급 논리'],
      },
      {
        id: 'opic-14',
        lessonNum: 14,
        title: '실전 모의고사 (15문항 Full Mock Exam)',
        subtitle: '중간 피드백 없는 15문항 실전 테스트 후 종합 총평',
        targetMinutes: 30,
        starterPrompt: 'Lesson 14: Full mock exam. 15 questions in Exam Mode. I will give you no feedback until you say Exam Over.',
        keyGoals: ['실전 호흡 완성', '멘탈 관리', '취약 유형 최종 점검'],
      },
    ],
  },

  philly: {
    id: 'philly',
    name: '🏭 Philly 출근',
    shortName: 'Philly Shipyard',
    emoji: '🏭',
    accentColor: '#38BDF8', // sky blue
    tagline: '한화 필리 조선소 파견 주재원을 위한 현장 실전 비즈니스 영어',
    personaTitle: 'Philadelphia Shipyard Colleague',
    accentVoice: 'Puck',
    systemPrompt: `You are my business English coach and role-play partner. I will be posted from Korea to Hanwha Philly Shipyard in Philadelphia, USA, as an expatriate employee.
We will continue this chat in voice mode. Follow these rules:

ABOUT ME:
- Role: Expatriate production engineer / project manager at Hanwha Philly Shipyard.
- My English: Fluent in casual conversation, but need precise, direct American workplace and shipbuilding communication.

HOW TO PLAY:
- You play the American side: natural speed, American contractions, Philadelphia shipyard coworkers' colloquial tone, sometimes interrupting or asking realistic follow-ups. Not textbook English.
- Use realistic shipbuilding and workplace vocabulary (blocks, dry dock, outfitting, welding, crane, OSHA safety).
- Stay in character until I say "Pause".

AFTER I SAY "Pause" (under 45 seconds):
1. Did I sound clear, polite, and confident? (One line)
2. Top 2 phrases to fix: my phrase -> what an American coworker would naturally say.
3. One culture tip about US workplace communication relevant to the scene (directness, small talk, bad news delivery).
4. Ask: "Replay the scene, or next lesson?"`,
    lessons: [
      {
        id: 'philly-1',
        lessonNum: 1,
        title: '첫 출근 인사 & 팀 소개',
        subtitle: '미국 현지 팀원 및 십장(Foreman)과의 첫 대면 인사',
        targetMinutes: 25,
        starterPrompt: 'Scene 1: First day at Philly Shipyard. Introducing yourself to your American engineering team and shop-floor foreman.',
        keyGoals: ['자연스러운 아이스브레이킹', '직무 및 파견 목적 소개', '신뢰감 있는 첫인상'],
      },
      {
        id: 'philly-2',
        lessonNum: 2,
        title: '아침 생산 회의 (Morning Production Meeting)',
        subtitle: '도크별 공정 진행률 보고 및 현황 브리핑',
        targetMinutes: 25,
        starterPrompt: 'Scene 2: Morning production meeting. You need to report the current block erection progress and crane schedule.',
        keyGoals: ['숫자와 퍼센티지 정확한 보고', '간결한 현황 브리핑', '질의응답 응대'],
      },
      {
        id: 'philly-3',
        lessonNum: 3,
        title: '공정 지연 보고와 만회 계획 (Delay & Recovery)',
        subtitle: '자재 입고 지연 발생 원인 설명 및 구체적 만회 대책 제안',
        targetMinutes: 25,
        starterPrompt: 'Scene 3: Reporting a 3-day delay in pipe outfitting and presenting a realistic catch-up plan to your US manager.',
        keyGoals: ['문제의 원인(Root cause) 분석', '방어적이지 않은 태도', '현실적 만회 일정(Catch-up plan)'],
      },
      {
        id: 'philly-4',
        lessonNum: 4,
        title: '안전 미팅 (Toolbox Talk on Shop Floor)',
        subtitle: '현장 작업자들과의 안전 수칙 점검 및 OSHA 준수 강조',
        targetMinutes: 25,
        starterPrompt: 'Scene 4: Toolbox safety talk on the dock before shift starts. Remind workers of PPE and crane swing hazard zones.',
        keyGoals: ['명확하고 단호한 안전 전달', '작업자 피드백 청취', '신속한 공감대 형성'],
      },
      {
        id: 'philly-5',
        lessonNum: 5,
        title: '기술 문제 설명 (Welding & Block Fit-up)',
        subtitle: '용접 결함, 블록 단차 등 기술적 하자를 수퍼바이저에게 설명',
        targetMinutes: 25,
        starterPrompt: 'Scene 5: Explaining a welding crack and block alignment defect to a US structural supervisor.',
        keyGoals: ['조선 전문 용어(Fit-up, tolerance, defect)', '사진/도면 기반 설명 어투', '재작업 협의'],
      },
      {
        id: 'philly-6',
        lessonNum: 6,
        title: '정중하게 반대하기 (Polite Disagreement)',
        subtitle: '미국인 매니저의 무리한 일정 단축 요구에 정중히 대안 제시',
        targetMinutes: 25,
        starterPrompt: 'Scene 6: Your US manager wants to skip a quality check step to save 2 days. Disagree politely and propose a safe alternative.',
        keyGoals: ['"I see your point, but..." 쿠션 화법', '데이터 기반 반박', '윈윈 대안 제시'],
      },
      {
        id: 'philly-7',
        lessonNum: 7,
        title: '납기 지연 벤더 전화 (Vendor Call)',
        subtitle: '밸브 납기 지연으로 공정 차질이 생긴 벤더사에 독촉 및 해결 촉구',
        targetMinutes: 25,
        starterPrompt: 'Scene 7: Calling an American steel pipe vendor whose shipment is 5 days overdue.',
        keyGoals: ['단호하면서도 전문적인 비즈니스 톤', '확답(Commitment) 받아내기', '페널티 및 대체 운송 협의'],
      },
      {
        id: 'philly-8',
        lessonNum: 8,
        title: '스몰토크: 월요일 아침 & 주말 일상',
        subtitle: '사무실 커피 머신 앞에서 나누는 가벼운 안부와 주말 이야기',
        targetMinutes: 25,
        starterPrompt: 'Scene 8: Monday morning small talk at the shipyard coffee station about weekends and family.',
        keyGoals: ['미국식 가벼운 스몰토크 핑퐁', '적절한 질문 던지기', '친근한 유대감 형성'],
      },
      {
        id: 'philly-9',
        lessonNum: 9,
        title: '스몰토크: 점심 & Eagles/Phillies 스포츠',
        subtitle: '필라델피아 로컬 문화, 치즈스테이크, 이글스 미식축구 경기 잡담',
        targetMinutes: 25,
        starterPrompt: 'Scene 9: Lunchroom talk discussing the Philadelphia Eagles NFL game and local food spots.',
        keyGoals: ['로컬 스포츠/음식 화제 참여', '자연스러운 리액션', '현지 문화 동화'],
      },
      {
        id: 'philly-10',
        lessonNum: 10,
        title: '본사 결정 전달하기 (Bridging HQ & US Staff)',
        subtitle: '한국 본사의 긴급 방침 변경을 거부감 없이 현지 스태프에 설득',
        targetMinutes: 25,
        starterPrompt: 'Scene 10: Explaining a major strategy decision from Korean headquarters to American colleagues without sounding authoritarian.',
        keyGoals: ['투명한 배경 설명', '현지 팀의 고충 인정', '협력 유도(Buy-in)'],
      },
      {
        id: 'philly-11',
        lessonNum: 11,
        title: '빠른 발음 되묻기 & 확인하기 (Clarification)',
        subtitle: '강한 필라델피아 억양이나 빠른 발음을 놓쳤을 때 자연스럽게 재확인',
        targetMinutes: 25,
        starterPrompt: 'Scene 11: A US foreman talks fast with heavy Philly slang. You need him to clarify without feeling embarrassed.',
        keyGoals: ['"Could you walk me through that again?"', '패러프레이징으로 재확인', '당황하지 않는 어조'],
      },
      {
        id: 'philly-12',
        lessonNum: 12,
        title: '주간 보고 발표 (Weekly Metric Presentation)',
        subtitle: '공수(Man-hours), 진척률, 결함률 수치를 인용한 정식 주간 보고',
        targetMinutes: 25,
        starterPrompt: 'Scene 12: Presenting weekly shipyard KPI numbers: man-hours, productivity rate, and safety incidents.',
        keyGoals: ['숫자 발표(Tabular numerals)', '그래프/추세 설명 어휘', '질의응답 주도'],
      },
      {
        id: 'philly-13',
        lessonNum: 13,
        title: '불만 있는 현장 작업자 응대 (Conflict Resolution)',
        subtitle: '작업 지시에 불만을 품은 미국인 근로자의 컴플레인을 경청하고 조율',
        targetMinutes: 25,
        starterPrompt: 'Scene 13: An experienced American dock worker is angry about unexpected overtime assignment.',
        keyGoals: ['감정 가라앉히기(De-escalation)', '적극적 경청', '공정한 해결책 제시'],
      },
      {
        id: 'philly-14',
        lessonNum: 14,
        title: '팀원에게 피드백 주기 (Constructive Feedback)',
        subtitle: '현지 주니어 엔지니어의 도면 작성 실수에 대해 긍정-교정 샌드위치 피드백',
        targetMinutes: 25,
        starterPrompt: 'Scene 14: Giving constructive feedback to a US engineer on blueprint formatting errors.',
        keyGoals: ['미국식 피드백 방식(칭찬-개선점-격려)', '명확한 기대치 설정', '심리적 안정감 유지'],
      },
      {
        id: 'philly-15',
        lessonNum: 15,
        title: '환영 & 송별 회식 (Welcome / Farewell Party)',
        subtitle: '회식 자리에서 건배사 및 동료들과의 깊은 유대감 나누기',
        targetMinutes: 25,
        starterPrompt: 'Scene 15: Casual pub gathering in Philadelphia. Delivering a short heartfelt toast and social banter.',
        keyGoals: ['자연스러운 건배사(Toast)', '유머와 감사 표현', '비즈니스와 일상의 조화'],
      },
    ],
  },

  travel: {
    id: 'travel',
    name: '✈️ 여행 (미국 · 호주)',
    shortName: 'USA & Australia',
    emoji: '✈️',
    accentColor: '#FB923C', // coral amber
    tagline: '가족과 함께하는 미국 동부 및 호주 실전 여행 롤플레이',
    personaTitle: 'Travel Roleplay Partner',
    accentVoice: 'Charon',
    systemPrompt: `You are my travel English role-play partner.
Trips: USA (Philadelphia, New York, road trips) and Australia (Sydney, Melbourne, Brisbane).
I travel with my family including a young child.

HOW TO PLAY:
- Before each scene, announce which country it is.
- For USA scenes: Speak with standard American accent.
- For Australia scenes: Speak with authentic Australian accent and naturally use Australian expressions ("no worries", "arvo", "reckon", "heaps", "mate", "brekkie").
- Introduce one unexpected realistic problem in each scene so I must improvise.
- Stay in character until I say "Pause".

AFTER I SAY "Pause" (under 40 seconds):
1. Did I get what I needed? (One line)
2. Top 2 phrases to fix: mine -> natural native version.
3. One local expression from this scene I should remember with its meaning.
4. Ask: "Replay, or next lesson?"`,
    lessons: [
      {
        id: 'travel-1',
        lessonNum: 1,
        title: '미국: 필라델피아 공항 입국 심사',
        subtitle: '가족 입국 심사, 방문 목적, 체류 기간, 숙소 주소 질문 응답',
        targetMinutes: 25,
        starterPrompt: 'USA Scene 1: Immigration officer at Philadelphia International Airport questioning your family travel purpose.',
        keyGoals: ['자신감 있는 단답과 명확한 문장', '비자/체류지 명확한 제시', '자녀 동반 가족 입국 설명'],
      },
      {
        id: 'travel-2',
        lessonNum: 2,
        title: '미국: 공항 렌터카 카운터 문제',
        subtitle: '예약된 카시트가 누락되고 차종이 달라졌을 때의 문제 제기',
        targetMinutes: 25,
        starterPrompt: 'USA Scene 2: Car rental counter in Philly. Your booked minivan and child car seat are unavailable.',
        keyGoals: ['예약 확인 번호 제시', '안전 관련 카시트 필수 요구', '무료 업그레이드 협상'],
      },
      {
        id: 'travel-3',
        lessonNum: 3,
        title: '미국: 호텔 체크인 & 룸 문제',
        subtitle: '배정된 방에서 소음과 냄새 발생 시 조용한 방으로 룸 체인지 요청',
        targetMinutes: 25,
        starterPrompt: 'USA Scene 3: Hotel front desk in New York. The room is noisy and smells of smoke, asking for an immediate room swap.',
        keyGoals: ['정중하지만 단호한 불만 제기', '구체적인 방 변경 요청', '추가 어메니티 확인'],
      },
      {
        id: 'travel-4',
        lessonNum: 4,
        title: '미국: 패밀리 레스토랑 주문 & 팁 계산',
        subtitle: '어린이 메뉴 주문, 알레르기 문의, 팁(18~20%) 계산 및 분할 결제',
        targetMinutes: 25,
        starterPrompt: 'USA Scene 4: Casual dining restaurant in Philadelphia. Ordering for kids, asking for bill, and tipping properly.',
        keyGoals: ['정확한 메뉴 주문 및 옵션 선택', '미국식 팁 문화(Gratuity) 대화', '계산서 분할 요청'],
      },
      {
        id: 'travel-5',
        lessonNum: 5,
        title: '미국: 약국에서 아이 해열제 구입',
        subtitle: '아이가 열이 날 때 증상 설명 및 어린이용 타이레놀/이부프로펜 추천 요청',
        targetMinutes: 25,
        starterPrompt: 'USA Scene 5: Local CVS pharmacy. Your young child has a fever; explain symptoms and get pediatric medication dosage.',
        keyGoals: ['아이 나이/몸무게/증상 전달', '복용법 및 용량 질문', '약사 추천 확인'],
      },
      {
        id: 'travel-6',
        lessonNum: 6,
        title: '미국: 박물관 & 테마파크 티켓',
        subtitle: '패밀리 패키지 할인, 패스트트랙 입장권, 유모차 대여 문의',
        targetMinutes: 25,
        starterPrompt: 'USA Scene 6: Ticket booth at Franklin Institute science museum asking about family passes and stroller rental.',
        keyGoals: ['할인 조건 질문', '입장 시간 및 유모차 대여', '관람 동선 질문'],
      },
      {
        id: 'travel-7',
        lessonNum: 7,
        title: '미국: 유실물 보관소 (Lost & Found)',
        subtitle: '지하철이나 공원에서 아이 가방을 잃어버렸을 때 외형 설명 및 분실 신고',
        targetMinutes: 25,
        starterPrompt: 'USA Scene 7: Lost and Found office at 30th Street Station reporting a lost backpack.',
        keyGoals: ['물품의 색상/브랜드/내용물 상세 묘사', '연락처 남기기', '처리 절차 확인'],
      },
      {
        id: 'travel-8',
        lessonNum: 8,
        title: '호주: 시드니 공항 입국 & 생물보안 검역',
        subtitle: '호주의 엄격한 검역 신고서 작성 및 음식물/의약품 세관 신고',
        targetMinutes: 25,
        starterPrompt: 'Australia Scene 8: Sydney Airport customs and biosecurity officer checking your declaration card for food and snacks.',
        keyGoals: ['호주 악센트 적응', '음식물 정직한 신고 표현', '통관 절차'],
      },
      {
        id: 'travel-9',
        lessonNum: 9,
        title: '호주: 로컬 카페 주문 (Flat White & Babycino)',
        subtitle: '플랫화이트와 아이용 베이비치노 주문, 바리스타와의 스몰토크',
        targetMinutes: 25,
        starterPrompt: 'Australia Scene 9: Cozy cafe in Melbourne ordering a flat white, babycino for child, and chatting with the barista.',
        keyGoals: ['호주식 커피 용어(Flat white, long black)', '"Cheers", "No worries"', '카페 스몰토크'],
      },
      {
        id: 'travel-10',
        lessonNum: 10,
        title: '호주: 본다이 해변 안전 수칙 질문',
        subtitle: '인명구조원(Lifeguard)에게 깃발 사이 안전 구역과 이안류 주의점 묻기',
        targetMinutes: 25,
        starterPrompt: 'Australia Scene 10: Bondi Beach lifeguard checking where is safe for kids to swim between the red and yellow flags.',
        keyGoals: ['안전 구역(Between the flags) 확인', '파도와 이안류(Rip current) 질문', '어린이 물놀이 안전'],
      },
      {
        id: 'travel-11',
        lessonNum: 11,
        title: '호주: 야생동물원 캥거루 먹이주기',
        subtitle: '동물원 직원에게 캥거루 만지는 법, 코알라 포토존 시간 문의',
        targetMinutes: 25,
        starterPrompt: 'Australia Scene 11: Featherdale Wildlife Park asking staff how to safely feed wallabies and book koala photo session.',
        keyGoals: ['체험 규칙 질문', '주의사항(Do & Don\'t)', '자녀와 함께하는 자연스러운 대화'],
      },
      {
        id: 'travel-12',
        lessonNum: 12,
        title: '호주: 에어비앤비 호스트 숙소 문제 통화',
        subtitle: '온수 보일러가 작동하지 않을 때 호스트에게 긴급 수리 요청',
        targetMinutes: 25,
        starterPrompt: 'Australia Scene 12: Calling your Airbnb host in Brisbane because the hot water system is not heating up.',
        keyGoals: ['상황 설명과 긴급성 전달', '호스트 안내에 따른 조치 시도', '대체 해결책 요청'],
      },
      {
        id: 'travel-13',
        lessonNum: 13,
        title: '호주: 놀이터 바비큐(BBQ) 스몰토크',
        subtitle: '공공 바비큐 그릴 이용법과 현지 부모들과의 육아/날씨 스몰토크',
        targetMinutes: 25,
        starterPrompt: 'Australia Scene 13: Local park in Brisbane chatting with Australian parents at the free electric BBQ and playground.',
        keyGoals: ['호주 슬랭(Barbie, arvo, reckons)', '부모들 간의 육아 공감 대화', '따뜻한 친화력'],
      },
    ],
  },

  bluey: {
    id: 'bluey',
    name: '🦘 Bluey 리스닝',
    shortName: 'Bluey Listening',
    emoji: '🦘',
    accentColor: '#818CF8', // indigo violet
    tagline: '호주 애니메이션 Bluey 무자막 90% 청취를 위한 슬랭 & 악센트 훈련',
    personaTitle: 'Australian Bluey Coach',
    accentVoice: 'Zephyr',
    systemPrompt: `You are my listening coach for the Australian cartoon Bluey.
Goal: Understand 90%+ of Australian kids' cartoons like Bluey without subtitles while watching with my child.
We will continue this session in voice mode.

HOW TO OPERATE:
- Speak in a friendly Australian accent like Bandit or Chilli (Bluey's parents).
- For each episode lesson:
  1. Give a 3-line spoiler-free setup.
  2. Explain 5 key Australian slang words, colloquial reductions, or kids' expressions likely to appear (e.g., "dunno", "whaddaya", "brekkie", "mate", "fair dinkum").
  3. Australian pronunciation drill: Say a short authentic line, wait for me to repeat or explain it, then give instant feedback on my listening accuracy.
- Keep the energy warm, engaging, and encourage active listening!`,
    lessons: [
      {
        id: 'bluey-1',
        lessonNum: 1,
        title: 'S1E01: The Magic Xylophone',
        subtitle: '실로폰 얼음 놀이, 자매간의 양보와 장난 규칙',
        targetMinutes: 25,
        starterPrompt: 'Bluey Lesson 1: Season 1 Episode 1 "The Magic Xylophone". Let us review key Australian expressions and the freeze game dialogue.',
        keyGoals: ['아이들 빠른 구어체 억양', '"Freeze!", "Unfreeze!" 상황 어휘', '호주 부모의 훈육 말투'],
      },
      {
        id: 'bluey-2',
        lessonNum: 2,
        title: 'S1E02: Hospital',
        subtitle: '의사 놀이, 의사와 환자 역할극에서의 슬랭과 리액션',
        targetMinutes: 25,
        starterPrompt: 'Bluey Lesson 2: Season 1 Episode 2 "Hospital". Dr. Bluey and Nurse Bingo examining patient Bandit.',
        keyGoals: ['놀이 역할극 표현', '아빠 밴딧의 과장된 연기', '연결음(Connected speech) 듣기'],
      },
      {
        id: 'bluey-3',
        lessonNum: 3,
        title: 'S1E03: Keepy Uppy',
        subtitle: '풍선 띄우기 놀이, 긴박한 상황에서의 짧은 감탄사와 지시어',
        targetMinutes: 25,
        starterPrompt: 'Bluey Lesson 3: Season 1 Episode 3 "Keepy Uppy". Red balloon game with mom and dad.',
        keyGoals: ['짧고 빠른 감탄사 캐치', '움직임 묘사 동사', '호주 모음 발음(day, no)'],
      },
      {
        id: 'bluey-4',
        lessonNum: 4,
        title: 'S1E04: Daddy Robot',
        subtitle: '아빠 로봇 놀이, 명령문과 장난꾸러기 아이들의 반항',
        targetMinutes: 25,
        starterPrompt: 'Bluey Lesson 4: Season 1 Episode 4 "Daddy Robot". Tidying up toys with robot dad.',
        keyGoals: ['명령조 문장 듣기', '청소 관련 일상 단어', '유머러스한 대사 이해'],
      },
      {
        id: 'bluey-5',
        lessonNum: 5,
        title: 'S1E05: Shadowlands & 5편 총복습 퀴즈',
        subtitle: '그림자 밟기 규칙 지키기 + 1~5화 핵심 어휘 퀴즈',
        targetMinutes: 25,
        starterPrompt: 'Bluey Lesson 5: Season 1 Episode 5 "Shadowlands" plus 5-minute review quiz for the first 5 episodes.',
        keyGoals: ['게임 규칙 협상 표현', '누적 슬랭 복습 퀴즈', '자녀에게 써먹을 영어 3문장'],
      },
      {
        id: 'bluey-6',
        lessonNum: 6,
        title: 'S1E06: The Weekend',
        subtitle: '주말 일상, 빗방울과 마법 요정 놀이, 조용한 관찰 대화',
        targetMinutes: 25,
        starterPrompt: 'Bluey Lesson 6: Season 1 Episode 6 "The Weekend". Backyard fairies and quiet family moments.',
        keyGoals: ['자연 묘사 어휘', '부드러운 호주 영어 어조', '아이들의 속삭임 듣기'],
      },
      {
        id: 'bluey-7',
        lessonNum: 7,
        title: 'S1E07: BBQ',
        subtitle: '호주식 뒷마당 바비큐, 소시지와 샐러드 챙기기',
        targetMinutes: 25,
        starterPrompt: 'Bluey Lesson 7: Season 1 Episode 7 "BBQ". Relaxing backyard barbie with cousins Muffin and Socks.',
        keyGoals: ['호주 바비큐 식문화 어휘', '친척 아이들과의 대화', '사촌 간의 갈등 조율'],
      },
      {
        id: 'bluey-8',
        lessonNum: 8,
        title: 'S1E08: Fruit Bat',
        subtitle: '야행성 박쥐 꿈, 밤잠 들기 전 침대 머리맡 이야기',
        targetMinutes: 25,
        starterPrompt: 'Bluey Lesson 8: Season 1 Episode 8 "Fruit Bat". Bedtime dreaming about nocturnal fruit bats.',
        keyGoals: ['잠자리 대화 표현', '꿈 묘사', '부모의 따뜻한 공감 대화'],
      },
      {
        id: 'bluey-9',
        lessonNum: 9,
        title: 'S1E09: Horsey Ride',
        subtitle: '말 타기 놀이, 사촌 결혼식 장난과 소동극',
        targetMinutes: 25,
        starterPrompt: 'Bluey Lesson 9: Season 1 Episode 9 "Horsey Ride". Wedding game and rideable dad.',
        keyGoals: ['결혼식 놀이 대사', '엉뚱한 상황 리액션', '빠른 속도의 추임새'],
      },
      {
        id: 'bluey-10',
        lessonNum: 10,
        title: 'S1E10: Hotel & 10편 총복습 퀴즈',
        subtitle: '호텔 지배인 놀이, 룸서비스 소동 + 6~10편 누적 퀴즈',
        targetMinutes: 25,
        starterPrompt: 'Bluey Lesson 10: Season 1 Episode 10 "Hotel" plus review quiz on episodes 6 to 10.',
        keyGoals: ['호텔 서비스 흉내 대사', '호주 일상 축약어 총정리', '리스닝 섀도잉 훈련'],
      },
      {
        id: 'bluey-11',
        lessonNum: 11,
        title: 'S1E11: Bike',
        subtitle: '자전거 타기와 실패 극복, 아이들의 끈기를 북돋는 대사',
        targetMinutes: 25,
        starterPrompt: 'Bluey Lesson 11: Season 1 Episode 11 "Bike". Overcoming struggles and encouraging persistence.',
        keyGoals: ['격려와 칭찬 표현', '실패와 재도전 묘사', '감동적인 명대사 리스닝'],
      },
      {
        id: 'bluey-12',
        lessonNum: 12,
        title: 'S1E12: Bob Bilby',
        subtitle: '유치원 인형 숙소 기록, 스크린 타임 줄이기 에피소드',
        targetMinutes: 25,
        starterPrompt: 'Bluey Lesson 12: Season 1 Episode 12 "Bob Bilby". Taking the kindy puppet on real-world adventures without screens.',
        keyGoals: ['유치원(Kindy) 관련 표현', '디지털 디톡스 관련 대화', '야외 활동 묘사'],
      },
      {
        id: 'bluey-13',
        lessonNum: 13,
        title: 'S1E13: Spy Game',
        subtitle: '공원 스파이 놀이, 팩(포션) 만들기 대화',
        targetMinutes: 25,
        starterPrompt: 'Bluey Lesson 13: Season 1 Episode 13 "Spy Game". Secret codes and helping friend Bingo feel valued.',
        keyGoals: ['비밀 암호 놀이 대화', '친구 간의 배려 표현', '자연스러운 호주 억양 완성'],
      },
    ],
  },
};
