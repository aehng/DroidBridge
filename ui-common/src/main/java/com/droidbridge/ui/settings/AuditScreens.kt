package com.droidbridge.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.droidbridge.ui.R
import com.droidbridge.ui.client.RuntimeConnection
import com.droidbridge.ui.common.RowIcon
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.text.DateFormat
import java.util.Date

data class AuditRecord(
    val rawJson: String,
    val timestamp: Long,
    val tool: String,
    val outcome: String,
    val latencyMs: Long,
    val argumentsJson: String?,
    val foregroundPackage: String?,
)

data class AuditUiState(
    val records: List<AuditRecord> = emptyList(),
    val loading: Boolean = true,
)

class AuditViewModel(private val client: RuntimeConnection) : ViewModel() {
    private val mutableState = MutableStateFlow(AuditUiState())
    val state: StateFlow<AuditUiState> = mutableState.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        mutableState.update { it.copy(loading = true) }
        viewModelScope.launch {
            val rows = runCatching { client.getVoiceAuditRows() }.getOrDefault(emptyList())
            val records = rows.mapNotNull { row -> parseRecord(row) }
            mutableState.update { AuditUiState(records = records, loading = false) }
        }
    }

    fun clear() {
        viewModelScope.launch {
            runCatching { client.clearVoiceAuditLog() }
            mutableState.update { AuditUiState(records = emptyList(), loading = false) }
        }
    }

    private fun parseRecord(json: String): AuditRecord? = runCatching {
        val obj = Json.parseToJsonElement(json).jsonObject
        val ts = obj["time"]?.jsonPrimitive?.longOrNull
            ?: obj["ts"]?.jsonPrimitive?.longOrNull
            ?: 0L
        val tool = obj["name"]?.jsonPrimitive?.content
            ?: obj["tool"]?.jsonPrimitive?.content
            ?: "unknown"
        val outcome = obj["outcome"]?.jsonPrimitive?.content ?: "unknown"
        val latency = obj["latency_ms"]?.jsonPrimitive?.longOrNull ?: 0L
        val pkg = obj["foreground_package"]?.jsonPrimitive?.content
        val args = obj["arguments"]?.toString()
        AuditRecord(
            rawJson = json,
            timestamp = ts,
            tool = tool,
            outcome = outcome,
            latencyMs = latency,
            argumentsJson = args,
            foregroundPackage = pkg,
        )
    }.getOrNull()
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun AuditRoute(
    viewModel: AuditViewModel,
    back: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var showConfirmClear by remember { mutableStateOf(false) }

    Scaffold(
        modifier = Modifier.testTag("route:AuditLog"),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.audit_title)) },
                navigationIcon = {
                    IconButton(onClick = back, modifier = Modifier.testTag("route:AuditLog:back")) {
                        Icon(painterResource(R.drawable.ic_arrow_back), stringResource(R.string.audit_title))
                    }
                },
                actions = {
                    if (state.records.isNotEmpty()) {
                        IconButton(
                            onClick = { showConfirmClear = true },
                            modifier = Modifier.testTag("audit:clear"),
                        ) {
                            Icon(painterResource(R.drawable.ic_delete_sweep), stringResource(R.string.audit_clear))
                        }
                    }
                },
            )
        },
    ) { padding ->
        when {
            state.loading -> {
                Column(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    CircularProgressIndicator(modifier = Modifier.testTag("audit:loading"))
                }
            }
            state.records.isEmpty() -> {
                Column(
                    modifier = Modifier.fillMaxSize().padding(padding).padding(32.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(
                        painter = painterResource(R.drawable.ic_verified_user),
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(bottom = 16.dp),
                    )
                    Text(
                        stringResource(R.string.audit_empty_title),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        stringResource(R.string.audit_empty_body),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
            }
            else -> {
                val timeFormat = remember { DateFormat.getTimeInstance(DateFormat.MEDIUM) }
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    items(state.records) { record ->
                        AuditItem(record = record, timeFormat = timeFormat)
                    }
                }
            }
        }
    }

    if (showConfirmClear) {
        AlertDialog(
            onDismissRequest = { showConfirmClear = false },
            title = { Text(stringResource(R.string.audit_clear_confirm_title)) },
            text = { Text(stringResource(R.string.audit_clear_confirm_body)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.clear()
                        showConfirmClear = false
                    },
                    modifier = Modifier.testTag("audit:confirm_clear"),
                ) {
                    Text(stringResource(R.string.audit_clear))
                }
            },
            dismissButton = {
                TextButton(onClick = { showConfirmClear = false }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }

    LaunchedEffect(Unit) {
        viewModel.refresh()
    }
}

@Composable
private fun AuditItem(record: AuditRecord, timeFormat: DateFormat) {
    ListItem(
        headlineContent = {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(record.tool, style = MaterialTheme.typography.titleSmall)
                Text(
                    text = record.outcome,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (record.outcome == "success") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                )
            }
        },
        supportingContent = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val timeStr = if (record.timestamp > 0) timeFormat.format(Date(record.timestamp)) else ""
                val meta = buildString {
                    if (timeStr.isNotEmpty()) append(timeStr)
                    if (record.latencyMs > 0) {
                        if (isNotEmpty()) append(" • ")
                        append("${record.latencyMs} ms")
                    }
                    if (!record.foregroundPackage.isNullOrEmpty()) {
                        if (isNotEmpty()) append(" • ")
                        append(record.foregroundPackage)
                    }
                }
                if (meta.isNotEmpty()) {
                    Text(meta, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (!record.argumentsJson.isNullOrEmpty() && record.argumentsJson != "{}") {
                    Text(
                        record.argumentsJson,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        },
        leadingContent = {
            RowIcon(
                when (record.outcome) {
                    "success" -> R.drawable.ic_verified_user
                    "auth_failed" -> R.drawable.ic_key
                    else -> R.drawable.ic_description
                }
            )
        },
        modifier = Modifier.testTag("audit:item"),
    )
}