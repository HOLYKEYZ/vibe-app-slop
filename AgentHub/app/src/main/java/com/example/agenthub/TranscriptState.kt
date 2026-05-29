package com.example.agenthub

fun restoreTranscriptLogs(savedTranscript: String, now: Long = System.currentTimeMillis()): List<LogLine> {
    return savedTranscript
        .takeLast(MAX_PERSISTED_TRANSCRIPT_CHARS)
        .split(Regex("\\n\\s*\\n"))
        .map { it.trim() }
        .filter { it.isNotBlank() }
        .takeLast(MAX_RENDERED_LOG_LINES)
        .mapIndexed { index, text -> LogLine(now + index, text, "append") }
}

fun consolidateLogs(logs: List<LogLine>): List<LogLine> {
    val consolidated = mutableListOf<LogLine>()
    for (log in logs.takeLast(MAX_RENDERED_LOG_LINES * 2)) {
        if (log.type == "replace" && consolidated.isNotEmpty() && consolidated.last().type == "replace") {
            consolidated[consolidated.size - 1] = log
        } else {
            consolidated.add(log)
        }
    }
    return consolidated.takeLast(MAX_RENDERED_LOG_LINES)
}

fun visibleTranscriptFrom(logs: List<LogLine>): String {
    return consolidateLogs(logs)
        .map { it.text }
        .filter { it.isNotBlank() }
        .joinToString("\n\n")
        .takeLast(MAX_PERSISTED_TRANSCRIPT_CHARS)
}

fun appendBoundedLog(logs: List<LogLine>, line: LogLine): List<LogLine> {
    if (logs.lastOrNull()?.text == line.text && logs.lastOrNull()?.type == line.type) return logs
    return (logs + line).takeLast(MAX_RENDERED_LOG_LINES * 2)
}
