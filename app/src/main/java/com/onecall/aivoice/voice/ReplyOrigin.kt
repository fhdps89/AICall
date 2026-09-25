package com.onecall.aivoice.voice

/** Where the reply being spoken came from (shown as small text on the call screen). */
sealed class ReplyOrigin {
    /** Gemini produced the reply. */
    object Ai : ReplyOrigin()

    /** No key saved: on-device rule-based [ReplyGenerator]. */
    object LocalNoKey : ReplyOrigin()

    /** Key is set but the AI call failed; the spoken retry line was used. */
    data class AiFailed(val reason: String) : ReplyOrigin()

    val label: String
        get() = when (this) {
            Ai -> "AI 대답"
            LocalNoKey -> "기본 대답(키 없음)"
            is AiFailed -> "AI 실패: $reason"
        }
}
