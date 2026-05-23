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
        // Handle deep link from QR URL
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

    // Config
    var sessionCode by remember { mutableStateOf(prefs.getString("SESSION_CODE", "") ?: "") }
    var serverUrl by remember { mutableStateOf(prefs.getString("SERVER_URL", "ws://192.168.100.13:3001") ?: "") }
    var showAdvanced by remember { mutableStateOf(false) }

    // Manual API keys (fallback when no relay)
    var codexSession by remember { mutableStateOf(prefs.getString("CODEX_SESSION", "") ?: "") }
    var opencodeSession by remember { mutableStateOf(prefs.getString("OPENCODE_SESSION", "") ?: "") }
    var windsurfSession by remember { mutableStateOf(prefs.getString("WINDSURF_SESSION", "") ?: "") }
    var kiroSession by remember { mutableStateOf(prefs.getString("KIRO_SESSION", "") ?: "") }
    var codexModel by remember { mutableStateOf(prefs.getString("CODEX_MODEL", "") ?: "") }
    var opencodeModel by remember { mutableStateOf(prefs.getString("OPENCODE_MODEL", "") ?: "") }
    var windsurfModel by remember { mutableStateOf(prefs.getString("WINDSURF_MODEL", "") ?: "") }
    var kiroModel by remember { mutableStateOf(prefs.getString("KIRO_MODEL", "") ?: "") }

    val listState = rememberLazyListState()

    val connectWs = {
        webSocket?.close(1000, "Reconnecting")
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
                    val j = JSONObject()
                    j.put("type", "config")
                    val c = JSONObject()
                    c.put("CODEX_SESSION", codexSession)
                    c.put("OPENCODE_SESSION", opencodeSession)
                    c.put("WINDSURF_SESSION", windsurfSession)
                    c.put("KIRO_SESSION", kiroSession)
                    if (codexModel.isNotBlank()) c.put("CODEX_MODEL", codexModel)
                    if (opencodeModel.isNotBlank()) c.put("OPENCODE_MODEL", opencodeModel)
                    if (windsurfModel.isNotBlank()) c.put("WINDSURF_MODEL", windsurfModel)
                    if (kiroModel.isNotBlank()) c.put("KIRO_MODEL", kiroModel)
                    j.put("config", c)
                    ws.send(j.toString())
                }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    when (json.optString("type")) {
                        "session_joined" -> {
                            relayOnline = json.optBoolean("relay_online", false)
                            val cfg = json.optJSONObject("config")
                            if (cfg != null) {
                                if (cfg.has("CODEX_SESSION") && codexSession.isBlank()) codexSession = cfg.getString("CODEX_SESSION")
                                if (cfg.has("OPENCODE_SESSION") && opencodeSession.isBlank()) opencodeSession = cfg.getString("OPENCODE_SESSION")
                                if (cfg.has("WINDSURF_SESSION") && windsurfSession.isBlank()) windsurfSession = cfg.getString("WINDSURF_SESSION")
                                if (cfg.has("KIRO_SESSION") && kiroSession.isBlank()) kiroSession = cfg.getString("KIRO_SESSION")
                            }
                            logs = logs + LogLine(System.currentTimeMillis(), "system",
                                if (relayOnline) "🔗 Relay connected" else "☁️ Cloud mode (laptop offline)")
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
                logs = logs + LogLine(System.currentTimeMillis(), "system", "Disconnected")
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                wsStatus = "disconnected"
                logs = logs + LogLine(System.currentTimeMillis(), "system", "Connection failed: ${t.message}")
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
        // Parse WS URL or plain code from QR
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

    // QR scanner overlay
    if (showQrScanner) {
        QrScanner(onScan = onQrScanned, onCancel = { showQrScanner = false })
        return
    }

    // Settings dialog (simplified: QR + code first, advanced collapsed)
    if (showSettings) {
        AlertDialog(
            onDismissRequest = { showSettings = false },
            title = { Text("Settings") },
            text = {
                LazyColumn {
                    item {
                        Text("Pair with Relay", fontWeight = FontWeight.Bold, color = Color(0xFFA7F3D0))
                        Spacer(Modifier.height(8.dp))
                        Button(
                            onClick = { showSettings = false; showQrScanner = true },
                            modifier = Modifier.fillMaxWidth().height(50.dp).clip(RoundedCornerShape(16.dp)),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF8B5CF6))
                        ) { Text("📷 Scan QR Code", color = Color.White) }
                        Spacer(Modifier.height(12.dp))
                        OutlinedTextField(
                            value = sessionCode,
                            onValueChange = { sessionCode = it },
                            label = { Text("Or paste session code") },
                            placeholder = { Text("e.g. Xk3mR9aB2q") },
                            singleLine = true
                        )
                        Spacer(Modifier.height(12.dp))
                        OutlinedTextField(
                            value = serverUrl,
                            onValueChange = { serverUrl = it },
                            label = { Text("Server URL") },
                            placeholder = { Text("ws://host:port") },
                            singleLine = true
                        )

                        Spacer(Modifier.height(8.dp))
                        TextButton(onClick = { showAdvanced = !showAdvanced }) {
                            Text(if (showAdvanced) "▲ Hide API Keys" else "▼ Manual API Keys (optional)")
                        }

                        if (showAdvanced) {
                            SettingsField("CODEX_SESSION", codexSession) { codexSession = it }
                            SettingsField("OPENCODE_SESSION", opencodeSession) { opencodeSession = it }
                            SettingsField("WINDSURF_SESSION", windsurfSession) { windsurfSession = it }
                            SettingsField("KIRO_SESSION", kiroSession) { kiroSession = it }
                            SettingsField("CODEX_MODEL", codexModel, true) { codexModel = it }
                            SettingsField("OPENCODE_MODEL", opencodeModel, true) { opencodeModel = it }
                            SettingsField("WINDSURF_MODEL", windsurfModel, true) { windsurfModel = it }
                            SettingsField("KIRO_MODEL", kiroModel, true) { kiroModel = it }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    prefs.edit()
                        .putString("SESSION_CODE", sessionCode).putString("SERVER_URL", serverUrl)
                        .putString("CODEX_SESSION", codexSession).putString("OPENCODE_SESSION", opencodeSession)
                        .putString("WINDSURF_SESSION", windsurfSession).putString("KIRO_SESSION", kiroSession)
                        .putString("CODEX_MODEL", codexModel).putString("OPENCODE_MODEL", opencodeModel)
                        .putString("WINDSURF_MODEL", windsurfModel).putString("KIRO_MODEL", kiroModel)
                        .apply()
                    showSettings = false
                    connectWs()
                }) { Text("Save & Reconnect") }
            }
        )
    }

    // Main UI
    Column(modifier = Modifier.fillMaxSize().padding(16.dp).padding(top = 32.dp, bottom = 16.dp)) {
        // Header
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(modifier = Modifier.size(10.dp).clip(CircleShape).background(if (wsStatus == "disconnected") Color.Red else Color.Green))
                Spacer(Modifier.width(8.dp))
                Text("Agent Hub", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
                if (wsStatus == "connected") {
                    Text(if (relayOnline) " 🔗" else " ☁️", color = Color(0xFFA7F3D0), fontSize = 12.sp)
                }
            }
            IconButton(onClick = { showSettings = true }) { Icon(Icons.Default.Settings, contentDescription = "Settings", tint = Color.White) }
        }

        Spacer(Modifier.height(16.dp))

        // If not connected, show big QR/pair prompt
        if (wsStatus == "disconnected" || logs.isEmpty()) {
            Box(modifier = Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Button(
                        onClick = { showQrScanner = true },
                        modifier = Modifier.size(120.dp).clip(RoundedCornerShape(24.dp)),
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF8B5CF6))
                    ) { Text("📷\nScan QR", fontSize = 20.sp, lineHeight = 28.sp) }
                    Spacer(Modifier.height(16.dp))
                    Text("or", color = Color.Gray)
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = { showSettings = true }) { Text("Enter session code", color = Color(0xFF8B5CF6)) }
                    if (wsStatus == "disconnected" && logs.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        Text("Connection failed — check server URL", color = Color.Red, fontSize = 12.sp)
                    }
                }
            }
            return@Column
        }

        // Agent Selector
        LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            items(agents) { agent ->
                val sel = agent.id == activeAgent.id
                Box(modifier = Modifier.width(100.dp).clip(RoundedCornerShape(16.dp))
                    .background(if (sel) Color(0xFF333340) else Color(0xFF1E1E24))
                    .clickable { activeAgent = agent }.padding(16.dp), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(modifier = Modifier.size(48.dp).clip(CircleShape).background(Color(0xFF8B5CF6)), contentAlignment = Alignment.Center) {
                            Text(agent.initial, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                        }
                        Spacer(Modifier.height(8.dp))
                        Text(agent.name, color = Color.White, fontSize = 12.sp)
                    }
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        // Terminal
        Box(modifier = Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Color(0xFF1E1E24)).padding(16.dp)) {
            LazyColumn(state = listState) {
                if (logs.isEmpty()) item { Text("Select an agent and start prompting...", color = Color.Gray, fontFamily = FontFamily.Monospace, fontSize = 12.sp) }
                val consolidated = mutableListOf<LogLine>()
                for (log in logs) {
                    if (log.type == "replace" && consolidated.isNotEmpty() && consolidated.last().type == "replace" && consolidated.last().agent == log.agent) {
                        consolidated[consolidated.size - 1] = log
                    } else { consolidated.add(log) }
                }
                items(consolidated) { log ->
                    val color = when (log.agent) { "user" -> Color.White; "system" -> Color.Gray; else -> Color(0xFFA7F3D0) }
                    Text(log.text, color = color, fontFamily = FontFamily.Monospace, fontSize = 12.sp, modifier = Modifier.padding(vertical = 2.dp))
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        // Input
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            TextField(
                value = input, onValueChange = { input = it },
                modifier = Modifier.weight(1f).clip(RoundedCornerShape(24.dp)),
                colors = TextFieldDefaults.colors(focusedContainerColor = Color(0xFF1E1E24), unfocusedContainerColor = Color(0xFF1E1E24),
                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, focusedTextColor = Color.White, unfocusedTextColor = Color.White),
                placeholder = { Text("Prompt ${activeAgent.name}...", color = Color.Gray) }
            )
            Spacer(Modifier.width(8.dp))
            IconButton(onClick = sendMsg, modifier = Modifier.size(50.dp).clip(CircleShape).background(Color(0xFF8B5CF6))) {
                Text("➤", color = Color.White, fontSize = 20.sp)
            }
        }
    }
}

@Composable
private fun SettingsField(label: String, value: String, optional: Boolean = false, onValueChange: (String) -> Unit) {
    OutlinedTextField(value = value, onValueChange = onValueChange, label = { Text(if (optional) "$label (opt)" else label) }, singleLine = true)
}
