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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import com.example.agenthub.theme.AgentHubTheme
import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class AgentInfo(val id: String, val name: String)
data class LogLine(val id: Long, val text: String, val type: String = "append")

val AGENT_NAMES = mapOf("codex" to "Codex", "opencode" to "OpenCode", "windsurf" to "Windsurf", "kiro" to "Kiro", "system" to "system")

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
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent) }
}

object OkHttpAgent {
    val client = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentHubScreen(initialDeepLink: String = "") {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("AgentHubPrefs", Context.MODE_PRIVATE) }

    var input by remember { mutableStateOf("") }
    var logs by remember { mutableStateOf(listOf<LogLine>()) }
    var wsStatus by remember { mutableStateOf("connecting") }
    var webSocket by remember { mutableStateOf<WebSocket?>(null) }
    var showSettings by remember { mutableStateOf(false) }
    var showQrScanner by remember { mutableStateOf(false) }
    var showModelPicker by remember { mutableStateOf(false) }
    var relayOnline by remember { mutableStateOf(false) }
    var currentAgent by remember { mutableStateOf(prefs.getString("CURRENT_AGENT", "") ?: "") }
    var agentModels by remember { mutableStateOf(listOf<String>()) }
    var currentModel by remember { mutableStateOf("") }

    var sessionCode by remember { mutableStateOf(prefs.getString("SESSION_CODE", "") ?: "") }
    var serverUrl by remember { mutableStateOf(prefs.getString("SERVER_URL", "wss://agent-hub-backend-wk48.onrender.com") ?: "") }

    val agentName = AGENT_NAMES[currentAgent] ?: "Agent"

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
                logs = logs + LogLine(System.currentTimeMillis(), "Connected to server")
                if (sessionCode.isNotBlank()) {
                    val j = JSONObject(); j.put("type", "join_session"); j.put("code", sessionCode)
                    ws.send(j.toString())
                } else {
                    logs = logs + LogLine(System.currentTimeMillis(), "Enter a session code in Settings")
                }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    when (json.optString("type")) {
                        "session_joined" -> {
                            relayOnline = json.optBoolean("relay_online", false)
                            if (currentAgent.isNotBlank()) {
                                logs = logs + LogLine(System.currentTimeMillis(),
                                    if (relayOnline) "$agentName ready (relay)" else "$agentName ready (cloud)")
                                val m = json.optJSONObject("agent_model")
                                if (m != null && m.has(currentAgent)) currentModel = m.getString(currentAgent)
                                val models = json.optJSONObject("available_models")
                                if (models != null && models.has(currentAgent)) {
                                    val arr = models.optJSONArray(currentAgent)
                                    if (arr != null) agentModels = (0 until arr.length()).map { arr.getString(it) }
                                }
                            } else {
                                logs = logs + LogLine(System.currentTimeMillis(), "Connected (scan QR or set agent in settings)")
                            }
                        }
                        "config_updated" -> {
                            val cfg = json.optJSONObject("config")
                            if (cfg != null && currentAgent.isNotBlank()) {
                                val modelKey = currentAgent.uppercase() + "_MODEL"
                                if (cfg.has(modelKey)) currentModel = cfg.getString(modelKey)
                            }
                        }
                        "stream" -> logs = logs + LogLine(System.currentTimeMillis(), stripAnsi(json.optString("content")))
                        "replace_stream" -> logs = logs + LogLine(System.currentTimeMillis(), stripAnsi(json.optString("content")), "replace")
                        "status", "system" -> logs = logs + LogLine(System.currentTimeMillis(), json.optString("content"))
                        "done" -> { val c = json.optString("content"); if (c.isNotBlank()) logs = logs + LogLine(System.currentTimeMillis(), c) }
                        "error" -> logs = logs + LogLine(System.currentTimeMillis(), "Error: ${json.optString("content")}")
                    }
                } catch (_: Exception) {}
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) { wsStatus = "disconnected" }
            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) { wsStatus = "disconnected" }
        }
        webSocket = OkHttpAgent.client.newWebSocket(request, listener)
    }

    DisposableEffect(serverUrl) { connectWs(); onDispose { webSocket?.close(1000, "Closing") } }

    LaunchedEffect(logs.size) { if (logs.isNotEmpty()) listState.animateScrollToItem(logs.size - 1) }

    val sendMsg = {
        if (input.isNotBlank() && wsStatus == "connected" && currentAgent.isNotBlank()) {
            logs = logs + LogLine(System.currentTimeMillis(), "> $input")
            val j = JSONObject(); j.put("agent", currentAgent); j.put("prompt", input)
            webSocket?.send(j.toString()); input = ""
        }
    }

    val onQrScanned = { raw: String ->
        showQrScanner = false
        try {
            val uri = java.net.URI(if (raw.startsWith("ws") || raw.startsWith("wss")) raw else "ws://x/$raw")
            val query = uri.query ?: ""
            val params = query.split("&").associate { kv -> kv.split("=", limit=2).let { it[0] to (it.getOrElse(1) { "" }) } }
            if (params.containsKey("code")) sessionCode = params["code"] ?: ""
            if (params.containsKey("agent")) currentAgent = params["agent"] ?: ""
            if (raw.startsWith("ws") || raw.startsWith("wss")) {
                serverUrl = "${uri.scheme}://${uri.host}:${uri.port}"
            }
            prefs.edit().putString("SESSION_CODE", sessionCode).putString("SERVER_URL", serverUrl)
                .putString("CURRENT_AGENT", currentAgent).apply()
            connectWs()
        } catch (_: Exception) {
            sessionCode = raw
            prefs.edit().putString("SESSION_CODE", raw).apply(); connectWs()
        }
    }

    val isConnected = wsStatus == "connected"

    // ─── QR Scanner ──────────────────────────────────────────────
    if (showQrScanner) { QrScanner(onScan = onQrScanned, onCancel = { showQrScanner = false }); return }

    // ─── Settings ─────────────────────────────────────────────────
    if (showSettings) {
        AlertDialog(
            onDismissRequest = { showSettings = false },
            title = { Text("Settings", color = Color.White, fontWeight = FontWeight.Bold) },
            containerColor = Color(0xFF1A1A2E),
            text = {
                LazyColumn(modifier = Modifier.heightIn(max = 480.dp)) {
                    item {
                        Text("Connect", fontWeight = FontWeight.Bold, color = Color(0xFF8B5CF6), fontSize = 14.sp)
                        Spacer(Modifier.height(8.dp))
                        Button(
                            onClick = { showSettings = false; showQrScanner = true },
                            modifier = Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(16.dp)),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF8B5CF6))
                        ) { Text("Scan QR Code", color = Color.White, fontSize = 16.sp) }
                        Spacer(Modifier.height(12.dp))
                        OutlinedTextField(value = sessionCode, onValueChange = { sessionCode = it },
                            label = { Text("Session Code") }, placeholder = { Text("e.g. Xk3mR9aB2q") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Color(0xFF8B5CF6), focusedLabelColor = Color(0xFF8B5CF6),
                                unfocusedTextColor = Color.White, focusedTextColor = Color.White, cursorColor = Color.White))
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(value = currentAgent, onValueChange = { currentAgent = it },
                            label = { Text("Agent") }, placeholder = { Text("codex / opencode / windsurf / kiro") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Color(0xFF8B5CF6), focusedLabelColor = Color(0xFF8B5CF6),
                                unfocusedTextColor = Color.White, focusedTextColor = Color.White, cursorColor = Color.White))
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(value = serverUrl, onValueChange = { serverUrl = it },
                            label = { Text("Server URL") }, placeholder = { Text("wss://host:port") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Color(0xFF8B5CF6), focusedLabelColor = Color(0xFF8B5CF6),
                                unfocusedTextColor = Color.White, focusedTextColor = Color.White, cursorColor = Color.White))
                    }
                }
            },
            confirmButton = {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = { showSettings = false }) { Text("Cancel", color = Color.Gray) }
                    TextButton(onClick = {
                        prefs.edit().putString("SESSION_CODE", sessionCode).putString("SERVER_URL", serverUrl)
                            .putString("CURRENT_AGENT", currentAgent).apply()
                        showSettings = false; connectWs()
                    }) { Text("Save", color = Color(0xFF8B5CF6)) }
                }
            }
        )
    }

    // ─── Model Picker ────────────────────────────────────────────
    if (showModelPicker && agentModels.isNotEmpty()) {
        AlertDialog(
            onDismissRequest = { showModelPicker = false },
            title = { Text("Model", color = Color.White, fontWeight = FontWeight.Bold) },
            containerColor = Color(0xFF1A1A2E),
            text = {
                Column {
                    agentModels.forEach { model ->
                        val isCurrent = model == currentModel
                        Row(
                            modifier = Modifier.fillMaxWidth().clickable {
                                val j = JSONObject(); j.put("type", "select_model")
                                j.put("agent", currentAgent); j.put("model", model)
                                webSocket?.send(j.toString()); showModelPicker = false
                            }.padding(vertical = 10.dp, horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            RadioButton(selected = isCurrent, onClick = {},
                                colors = RadioButtonDefaults.colors(selectedColor = Color(0xFF8B5CF6)))
                            Spacer(Modifier.width(8.dp))
                            Text(model, color = if (isCurrent) Color.White else Color(0xFFBBBBBB), fontSize = 13.sp)
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { showModelPicker = false }) { Text("Cancel", color = Color.Gray) } }
        )
    }

    // ─── Main UI ─────────────────────────────────────────────────
    Column(modifier = Modifier.fillMaxSize().padding(top = 44.dp, bottom = 8.dp, start = 12.dp, end = 12.dp)) {
        // Header
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(modifier = Modifier.size(12.dp).clip(CircleShape).background(
                    if (isConnected && relayOnline) Color(0xFF4ADE80) else if (isConnected) Color(0xFFFBBF24) else Color(0xFFEF4444)))
                Spacer(Modifier.width(8.dp))
                if (currentAgent.isNotBlank()) {
                    Text(agentName, color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    if (isConnected) {
                        Text(if (relayOnline) "  ● Relay" else "  ● Cloud", color = Color(0xFF8B5CF6), fontSize = 11.sp, fontWeight = FontWeight.Medium)
                    }
                } else {
                    Text("Agent Hub", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                }
            }
            Row {
                if (currentModel.isNotBlank() && isConnected && agentModels.isNotEmpty()) {
                    Text(currentModel, color = Color(0xFF8B5CF6), fontSize = 10.sp,
                        modifier = Modifier.clickable { showModelPicker = true }.padding(end = 8.dp, top = 4.dp))
                }
                if (!isConnected) {
                    Button(onClick = { showSettings = true },
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

        Spacer(Modifier.height(8.dp))

        // Chat area
        Box(modifier = Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(16.dp))
            .background(Color(0xFF1E1E24)).padding(12.dp)) {
            if (!isConnected) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Not connected", color = Color(0xFF666666), fontSize = 16.sp)
                        Spacer(Modifier.height(4.dp))
                        Text("Settings → Scan QR or enter session code", color = Color(0xFF444444), fontSize = 12.sp)
                        Spacer(Modifier.height(24.dp))
                        Button(onClick = { showSettings = true },
                            modifier = Modifier.clip(RoundedCornerShape(24.dp)).height(48.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF8B5CF6))
                        ) { Text("Connect", color = Color.White) }
                    }
                }
            } else if (logs.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Connected", color = Color(0xFF4ADE80), fontSize = 14.sp)
                        Spacer(Modifier.height(4.dp))
                        Text("Send a prompt to ${if (currentAgent.isNotBlank()) agentName else "your agent"}", color = Color(0xFF444444), fontSize = 12.sp)
                    }
                }
            } else {
                LazyColumn(state = listState) {
                    val consolidated = mutableListOf<LogLine>()
                    for (log in logs) {
                        if (log.type == "replace" && consolidated.isNotEmpty() && consolidated.last().type == "replace") {
                            consolidated[consolidated.size - 1] = log
                        } else { consolidated.add(log) }
                    }
                    items(consolidated) { log ->
                        val color = when { log.text.startsWith("> ") -> Color.White; log.text.startsWith("Error") -> Color(0xFFEF4444); else -> Color(0xFFA7F3D0) }
                        if (log.text.isNotBlank()) {
                            Text(log.text, color = color, fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                                modifier = Modifier.padding(vertical = 1.dp))
                        }
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
                enabled = isConnected && currentAgent.isNotBlank(),
                colors = TextFieldDefaults.colors(focusedContainerColor = Color(0xFF1E1E24), unfocusedContainerColor = Color(0xFF1E1E24),
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent,
                    focusedTextColor = Color.White, unfocusedTextColor = Color.White,
                    disabledContainerColor = Color(0xFF151518), disabledTextColor = Color(0xFF333333)),
                placeholder = { Text(
                    if (!isConnected) "Connect to send prompts"
                    else if (currentAgent.isBlank()) "Set agent in Settings"
                    else "Prompt $agentName...",
                    color = if (isConnected && currentAgent.isNotBlank()) Color.Gray else Color(0xFF333333)) }
            )
            Spacer(Modifier.width(8.dp))
            Box(modifier = Modifier.size(48.dp).clip(CircleShape).background(
                if (isConnected && currentAgent.isNotBlank()) Color(0xFF8B5CF6) else Color(0xFF1E1E24))
                .clickable(enabled = isConnected && currentAgent.isNotBlank()) { sendMsg() },
                contentAlignment = Alignment.Center) {
                Text("➤", color = if (isConnected && currentAgent.isNotBlank()) Color.White else Color(0xFF333333), fontSize = 20.sp)
            }
        }
    }
}
