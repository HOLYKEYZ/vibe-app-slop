package com.example.agenthub

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.agenthub.theme.AgentHubTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class Agent(val id: String, val name: String, val initial: String)
data class LogLine(val id: Long, val agent: String, val text: String, val type: String = "append")

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val intentData = intent?.data?.toString() ?: ""
        setContent {
            AgentHubTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = Color(0xFF0A0A0C)) {
                    AgentHubScreen(initialDeepLink = intentData)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }
}

object OkHttpAgent {
    val client = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentHubScreen(initialDeepLink: String = "") {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("AgentHubPrefs", Context.MODE_PRIVATE) }

    val agents = listOf(
        Agent("codex", "Codex", "C"), Agent("opencode", "OpenCode", "O"),
        Agent("windsurf", "Windsurf", "W"), Agent("kiro", "Kiro", "K")
    )

    var activeAgent by remember { mutableStateOf(agents[0]) }
    var input by remember { mutableStateOf("") }
    var logs by remember { mutableStateOf(listOf<LogLine>()) }
    var wsStatus by remember { mutableStateOf("connecting") }
    var webSocket by remember { mutableStateOf<WebSocket?>(null) }
    var showSettings by remember { mutableStateOf(false) }
    var showQrScanner by remember { mutableStateOf(false) }
    var relayOnline by remember { mutableStateOf(false) }

    var sessionCode by remember { mutableStateOf(prefs.getString("SESSION_CODE", "") ?: "") }
    var serverUrl by remember { mutableStateOf(prefs.getString("SERVER_URL", "wss://agent-hub-backend-wk48.onrender.com") ?: "") }
    fun stripAnsi(str: String): String {
        return str.replace(Regex("\\u001B\\[[;\\d]*[A-Za-z]"), "").replace(Regex("\\u001B\\]\\d+;[^\\u0007]*\\u0007"), "")
    }

    val listState = rememberLazyListState()

    val connectWs = {
        webSocket?.close(1000, "Reconnecting")
        logs = emptyList()
        val request = Request.Builder().url(serverUrl).build()
        val listener = object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                wsStatus = "connected"
                logs = logs + LogLine(System.currentTimeMillis(), "system", "Connected to server")
                if (sessionCode.isNotBlank()) {
                    val j = JSONObject()
                    j.put("type", "join_session")
                    j.put("code", sessionCode)
                    ws.send(j.toString())
                } else {
                    logs = logs + LogLine(System.currentTimeMillis(), "system", "Enter a session code in Settings to connect")
                }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    when (json.optString("type")) {
                        "session_joined" -> {
                            relayOnline = json.optBoolean("relay_online", false)
                            logs = logs + LogLine(System.currentTimeMillis(), "system",
                                if (relayOnline) "Connected to relay session" else "Cloud mode (laptop offline)")
                        }
                        "stream" -> logs = logs + LogLine(System.currentTimeMillis(), activeAgent.id, json.optString("content"))
                        "replace_stream" -> logs = logs + LogLine(System.currentTimeMillis(), activeAgent.id, json.optString("content"), "replace")
                        "status", "system" -> logs = logs + LogLine(System.currentTimeMillis(), "system", json.optString("content"))
                        "done" -> logs = logs + LogLine(System.currentTimeMillis(), activeAgent.id, json.optString("content"))
                        "error" -> logs = logs + LogLine(System.currentTimeMillis(), "system", "Error: ${json.optString("content")}")
                    }
                } catch (_: Exception) {}
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                wsStatus = "disconnected"
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                wsStatus = "disconnected"
            }
        }
        webSocket = OkHttpAgent.client.newWebSocket(request, listener)
    }

    DisposableEffect(serverUrl) { connectWs(); onDispose { webSocket?.close(1000, "Closing") } }

    LaunchedEffect(logs.size) { if (logs.isNotEmpty()) listState.animateScrollToItem(logs.size - 1) }

    val sendMsg = {
        if (input.isNotBlank() && wsStatus == "connected") {
            logs = logs + LogLine(System.currentTimeMillis(), "user", "> $input")
            val j = JSONObject()
            j.put("agent", activeAgent.id)
            j.put("prompt", input)
            webSocket?.send(j.toString())
            input = ""
        }
    }

    val onQrScanned = { raw: String ->
        showQrScanner = false
        try {
            if (raw.startsWith("ws") || raw.startsWith("wss")) {
                val uri = java.net.URI(raw)
                serverUrl = "${uri.scheme}://${uri.host}:${uri.port}"
                uri.query?.split("&")?.find { it.startsWith("code=") }?.substringAfter("=")?.let { sessionCode = it }
            } else {
                sessionCode = raw
            }
            prefs.edit().putString("SESSION_CODE", sessionCode).putString("SERVER_URL", serverUrl).apply()
            connectWs()
        } catch (_: Exception) {
            sessionCode = raw
            prefs.edit().putString("SESSION_CODE", raw).apply()
            connectWs()
        }
    }

    val isConnected = wsStatus == "connected"

    // ─── QR Scanner Overlay ──────────────────────────────────────
    if (showQrScanner) {
        QrScanner(onScan = onQrScanned, onCancel = { showQrScanner = false })
        return
    }

    // ─── Settings Dialog ─────────────────────────────────────────
    if (showSettings) {
        AlertDialog(
            onDismissRequest = { showSettings = false },
            title = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Settings", color = Color.White, fontWeight = FontWeight.Bold)
                }
            },
            containerColor = Color(0xFF1A1A2E),
            text = {
                LazyColumn(modifier = Modifier.heightIn(max = 480.dp)) {
                    item {
                        Text("Pair with Relay", fontWeight = FontWeight.Bold, color = Color(0xFF8B5CF6), fontSize = 14.sp)
                        Spacer(Modifier.height(8.dp))
                        Button(
                            onClick = { showSettings = false; showQrScanner = true },
                            modifier = Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(16.dp)),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF8B5CF6))
                        ) { Text("Scan QR Code", color = Color.White, fontSize = 16.sp) }
                        Spacer(Modifier.height(12.dp))
                        OutlinedTextField(
                            value = sessionCode,
                            onValueChange = { sessionCode = it },
                            label = { Text("Session Code") },
                            placeholder = { Text("e.g. Xk3mR9aB2q") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Color(0xFF8B5CF6), focusedLabelColor = Color(0xFF8B5CF6),
                                unfocusedTextColor = Color.White, focusedTextColor = Color.White, cursorColor = Color.White)
                        )
                        Spacer(Modifier.height(12.dp))
                        OutlinedTextField(
                            value = serverUrl,
                            onValueChange = { serverUrl = it },
                            label = { Text("Server URL") },
                            placeholder = { Text("wss://host:port") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Color(0xFF8B5CF6), focusedLabelColor = Color(0xFF8B5CF6),
                                unfocusedTextColor = Color.White, focusedTextColor = Color.White, cursorColor = Color.White)
                        )


                    }
                }
            },
            confirmButton = {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = { showSettings = false }) { Text("Cancel", color = Color.Gray) }
                    TextButton(onClick = {
                        prefs.edit()
                            .putString("SESSION_CODE", sessionCode).putString("SERVER_URL", serverUrl)
                            .apply()
                        showSettings = false
                        connectWs()
                    }) { Text("Save & Connect", color = Color(0xFF8B5CF6)) }
                }
            }
        )
    }

    // ─── Main UI ─────────────────────────────────────────────────
    Column(modifier = Modifier.fillMaxSize().padding(top = 40.dp, bottom = 8.dp, start = 12.dp, end = 12.dp)) {
        // Header
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(modifier = Modifier.size(12.dp).clip(CircleShape).background(
                    if (isConnected && relayOnline) Color(0xFF4ADE80) else if (isConnected) Color(0xFFFBBF24) else Color(0xFFEF4444)))
                Spacer(Modifier.width(8.dp))
                Text("Agent Hub", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                if (isConnected) {
                    Text(if (relayOnline) "  Relay" else "  Cloud", color = Color(0xFF8B5CF6), fontSize = 11.sp,
                        fontWeight = FontWeight.Medium)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (!isConnected) {
                    Button(
                        onClick = { showSettings = true },
                        modifier = Modifier.height(36.dp).clip(RoundedCornerShape(18.dp)),
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF8B5CF6)),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 0.dp)
                    ) { Text("Connect", color = Color.White, fontSize = 13.sp) }
                    Spacer(Modifier.width(8.dp))
                }
                IconButton(onClick = { showSettings = true }) {
                    Icon(Icons.Default.Settings, contentDescription = "Settings", tint = Color(0xFF888888))
                }
            }
        }

        Spacer(Modifier.height(12.dp))

        // Agent selector pills
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            items(agents) { agent ->
                val sel = agent.id == activeAgent.id
                Box(modifier = Modifier
                    .clip(RoundedCornerShape(20.dp))
                    .background(if (sel) Color(0xFF8B5CF6) else Color(0xFF1E1E24))
                    .clickable { activeAgent = agent }
                    .padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(modifier = Modifier.size(24.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.2f)),
                            contentAlignment = Alignment.Center) {
                            Text(agent.initial, color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(Modifier.width(8.dp))
                        Text(agent.name, color = Color.White, fontSize = 13.sp, fontWeight = if (sel) FontWeight.Bold else FontWeight.Normal)
                    }
                }
            }
        }

        Spacer(Modifier.height(12.dp))

        // Terminal / Chat area
        Box(modifier = Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(16.dp))
            .background(Color(0xFF1E1E24)).padding(12.dp)) {
            if (!isConnected) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Not connected", color = Color(0xFF666666), fontSize = 16.sp)
                        Spacer(Modifier.height(4.dp))
                        Text("Settings → Scan QR or enter session code", color = Color(0xFF444444), fontSize = 12.sp)
                        Spacer(Modifier.height(24.dp))
                        Button(
                            onClick = { showSettings = true },
                            modifier = Modifier.clip(RoundedCornerShape(24.dp)).height(48.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF8B5CF6))
                        ) { Text("Connect to Server", color = Color.White) }
                    }
                }
            } else if (logs.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Connected", color = Color(0xFF4ADE80), fontSize = 14.sp)
                        Spacer(Modifier.height(4.dp))
                        Text("Select an agent and send a prompt", color = Color(0xFF444444), fontSize = 12.sp)
                    }
                }
            } else {
                LazyColumn(state = listState) {
                    val consolidated = mutableListOf<LogLine>()
                    for (log in logs) {
                        if (log.type == "replace" && consolidated.isNotEmpty() && consolidated.last().type == "replace" && consolidated.last().agent == log.agent) {
                            consolidated[consolidated.size - 1] = log
                        } else { consolidated.add(log) }
                    }
                    items(consolidated) { log ->
                        val color = when (log.agent) { "user" -> Color.White; "system" -> Color(0xFF888888); else -> Color(0xFFA7F3D0) }
                        Text(stripAnsi(log.text), color = color, fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                            modifier = Modifier.padding(vertical = 1.dp))
                    }
                }
            }
        }

        Spacer(Modifier.height(8.dp))

        // Input bar
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            TextField(
                value = input, onValueChange = { input = it },
                modifier = Modifier.weight(1f).clip(RoundedCornerShape(24.dp)).height(48.dp),
                enabled = isConnected,
                colors = TextFieldDefaults.colors(focusedContainerColor = Color(0xFF1E1E24), unfocusedContainerColor = Color(0xFF1E1E24),
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                    focusedTextColor = Color.White, unfocusedTextColor = Color.White,
                    disabledContainerColor = Color(0xFF151518), disabledTextColor = Color(0xFF333333)),
                placeholder = { Text(if (isConnected) "Prompt ${activeAgent.name}..." else "Connect to send prompts", color = if (isConnected) Color.Gray else Color(0xFF333333)) }
            )
            Spacer(Modifier.width(8.dp))
            Box(modifier = Modifier.size(48.dp).clip(CircleShape).background(
                if (isConnected) Color(0xFF8B5CF6) else Color(0xFF1E1E24)).clickable(enabled = isConnected) { sendMsg() },
                contentAlignment = Alignment.Center) {
                Text("➤", color = if (isConnected) Color.White else Color(0xFF333333), fontSize = 20.sp)
            }
        }
    }
}

