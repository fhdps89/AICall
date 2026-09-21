package com.onecall.aivoice.voice

/** High-level call UI / engine phase. */
enum class CallPhase {
    Idle,
    Greeting,
    Listening,
    Thinking,
    Speaking,
    Ended
}
