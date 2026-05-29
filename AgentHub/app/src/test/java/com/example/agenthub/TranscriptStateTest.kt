package com.example.agenthub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptStateTest {
    @Test
    fun restoreTranscriptLogsCapsHugeSavedHistory() {
        val saved = (1..300).joinToString("\n\n") { "message $it" }

        val restored = restoreTranscriptLogs(saved, now = 1000L)

        assertEquals(MAX_RENDERED_LOG_LINES, restored.size)
        assertEquals("message 211", restored.first().text)
        assertEquals("message 300", restored.last().text)
    }

    @Test
    fun consolidateLogsKeepsOnlyLatestReplacement() {
        val logs = listOf(
            LogLine(1, "user prompt", "user"),
            LogLine(2, "partial", "replace"),
            LogLine(3, "full answer", "replace"),
        )

        val consolidated = consolidateLogs(logs)

        assertEquals(listOf("user prompt", "full answer"), consolidated.map { it.text })
    }

    @Test
    fun appendBoundedLogCapsInternalList() {
        val logs = (1..250).map { LogLine(it.toLong(), "line $it") }

        val next = appendBoundedLog(logs, LogLine(251, "line 251"))

        assertEquals(MAX_RENDERED_LOG_LINES * 2, next.size)
        assertEquals("line 72", next.first().text)
        assertEquals("line 251", next.last().text)
    }

    @Test
    fun visibleTranscriptCapsPersistedText() {
        val logs = (1..MAX_RENDERED_LOG_LINES).map {
            LogLine(it.toLong(), "x".repeat(1000))
        }

        val transcript = visibleTranscriptFrom(logs)

        assertTrue(transcript.length <= MAX_PERSISTED_TRANSCRIPT_CHARS)
    }
}
