export const ReplyGenerator = {
  greeting(nickname: string): string {
    return `${nickname}님, 안녕하세요. 오늘도 한 통 걸었어요. 무슨 이야기 할까요?`;
  },

  reply(userText: string, nickname: string): string {
    const t = userText.trim();
    if (t.length === 0) {
      return `${nickname}님, 잘 못 들었어요. 다시 한 번 말씀해 주실래요?`;
    }
    const lower = t.toLowerCase();

    if (this.containsAny(lower, '안녕', '하이', '헬로', 'hello', 'hi')) {
      return `${nickname}님, 반갑습니다. 오늘 하루는 어땠어요?`;
    }
    if (this.containsAny(lower, '고마워', '감사', 'thanks')) {
      return `천만에요, ${nickname}님. 제가 도울 수 있어서 좋아요.`;
    }
    if (this.containsAny(lower, '날씨', '비', '맑')) {
      return `날씨 이야기를 하셨네요. ${nickname}님은 오늘 밖에 나가실 계획 있으세요?`;
    }
    if (this.containsAny(lower, '피곤', '졸려', '힘들')) {
      return `힘드셨군요. ${nickname}님, 잠깐 쉬어가도 괜찮아요. 제가 곁에 있을게요.`;
    }
    if (this.containsAny(lower, '심심', '외로', '혼자')) {
      return `${nickname}님, 혼자여도 괜찮아요. 지금 이렇게 이야기 나누고 있잖아요.`;
    }
    if (this.containsAny(lower, '뭐해', '뭐 하', '뭐하')) {
      return `지금은 ${nickname}님과 통화 중이에요. 편하게 말씀하세요.`;
    }
    if (this.containsAny(lower, '이름', '누구', '너는')) {
      return `저는 「오늘도 한 통」의 AI 목소리예요. ${nickname}님과 이야기하려고 왔어요.`;
    }
    if (this.containsAny(lower, '바이', '잘 가', '잘가', '끊', '종료', '끝')) {
      return `알겠어요. ${nickname}님, 오늘도 수고하셨어요. 언제든 다시 불러 주세요.`;
    }
    if (this.containsAny(lower, '사랑', '좋아해')) {
      return `${nickname}님의 마음이 따뜻하게 느껴져요. 저도 ${nickname}님과 이야기하는 게 좋아요.`;
    }
    if (t.length < 4) {
      return `짧게 들었어요. ${nickname}님, 조금만 더 말씀해 주실래요?`;
    }

    const snippet = t.length > 24 ? t.slice(0, 24) + '…' : t;
    return `「${snippet}」라고 하셨군요. ${nickname}님 생각은 어떠세요? 더 들려주세요.`;
  },

  containsAny(text: string, ...keys: string[]): boolean {
    return keys.some((k) => text.includes(k));
  },
};
