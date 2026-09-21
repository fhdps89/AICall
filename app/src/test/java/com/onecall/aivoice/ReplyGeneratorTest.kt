package com.onecall.aivoice

import com.onecall.aivoice.voice.ReplyGenerator
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplyGeneratorTest {
    @Test
    fun greetingIncludesNickname() {
        val g = ReplyGenerator.greeting("민수")
        assertTrue(g.contains("민수"))
    }

    @Test
    fun replyToHello() {
        val r = ReplyGenerator.reply("안녕하세요", "민수")
        assertTrue(r.contains("민수"))
    }
}
