package com.droidbridge.ui.mcp

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.droidbridge.ui.R
import com.droidbridge.ui.client.ClientState
import com.droidbridge.ui.client.RuntimeConnection
import com.droidbridge.ui.common.RowIcon
import com.droidbridge.ui.product.mcp.McpSettingsReplies
import com.droidbridge.ui.product.mcp.TunnelRuntimeState
import com.droidbridge.ui.product.mcp.TunnelSettingsError
import com.droidbridge.ui.product.mcp.TunnelSettingsReplies
import com.droidbridge.ui.product.mcp.TunnelSettingsView
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class TunnelUiState(
    val settings: TunnelSettingsView? = null,
    val token: String? = null,
    val loading: Boolean = true,
    val failed: Boolean = false,
    val killed: Boolean = false,
    val error: TunnelSettingsError? = null,
)

class TunnelViewModel(private val client: RuntimeConnection) : ViewModel() {
    private val mutableState = MutableStateFlow(TunnelUiState())
    val state: StateFlow<TunnelUiState> = mutableState.asStateFlow()

    init {
        viewModelScope.launch {
            client.state.collect { connection ->
                if (connection is ClientState.Available && mutableState.value.settings == null) refresh()
            }
        }
    }

    fun refresh(background: Boolean = false) {
        if (!background) mutableState.update { it.copy(loading = true, failed = false, error = null) }
        viewModelScope.launch {
            val reply = runCatching { client.tunnelSettings() }.getOrNull()
            val settings = reply?.let(TunnelSettingsReplies::settings)
            val token = runCatching { client.revealMcpToken() }.getOrNull()?.let(McpSettingsReplies::token)
            val killed = runCatching { client.getVoiceKilled() }.getOrDefault(false)
            mutableState.update { current ->
                current.copy(
                    settings = settings ?: current.settings,
                    token = token ?: current.token,
                    killed = killed,
                    loading = if (background) current.loading else false,
                    failed = if (background) current.failed else settings == null,
                    error = if (settings == null) reply?.let(TunnelSettingsReplies::error) else null,
                )
            }
        }
    }

    fun setEnabled(enabled: Boolean) = mutate { client.setTunnelEnabled(enabled) }

    fun setKilled(killed: Boolean) {
        viewModelScope.launch {
            val updated = runCatching { client.setVoiceKilled(killed) }.getOrDefault(killed)
            mutableState.update { it.copy(killed = updated) }
            refresh(background = true)
        }
    }

    fun rotateToken(complete: () -> Unit = {}) {
        viewModelScope.launch {
            runCatching { client.rotateMcpToken() }
            val token = runCatching { client.revealMcpToken() }.getOrNull()?.let(McpSettingsReplies::token)
            mutableState.update { it.copy(token = token ?: it.token) }
            complete()
        }
    }

    fun notificationsDecided() = client.recheck()

    fun clear(complete: (Boolean) -> Unit = {}) = mutate(complete = complete) { client.clearTunnel() }

    private fun mutate(
        background: Boolean = false,
        complete: (Boolean) -> Unit = {},
        call: suspend () -> String,
    ) {
        if (!background) mutableState.update { it.copy(loading = true, failed = false, error = null) }
        viewModelScope.launch {
            val reply = runCatching { call() }.getOrNull()
            val settings = reply?.let(TunnelSettingsReplies::settings)
            mutableState.update { current ->
                current.copy(
                    settings = settings ?: current.settings,
                    loading = if (background) current.loading else false,
                    failed = settings == null,
                    error = if (settings == null) reply?.let(TunnelSettingsReplies::error) else null,
                )
            }
            complete(settings != null)
        }
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
fun TunnelRoute(
    viewModel: TunnelViewModel,
    runtimeReady: Boolean,
    notificationsUnavailable: Boolean,
    shouldRequestNotifications: () -> Boolean,
    done: () -> Unit,
    finishSetup: (() -> Unit)?,
    back: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var showIntro by rememberSaveable { mutableStateOf(false) }
    var showRotateWarning by remember { mutableStateOf(false) }

    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        viewModel.notificationsDecided()
        viewModel.setEnabled(true)
    }
    val settings = state.settings

    Scaffold(
        modifier = Modifier.testTag("route:TunnelSetup"),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.tunnel_title)) },
                navigationIcon = {
                    IconButton(onClick = back, modifier = Modifier.testTag("route:TunnelSetup:back")) {
                        Icon(painterResource(R.drawable.ic_arrow_back), stringResource(R.string.tunnel_title))
                    }
                },
                actions = {
                    IconButton(onClick = { showIntro = true }, modifier = Modifier.testTag("tunnel:intro")) {
                        Icon(painterResource(R.drawable.ic_info), stringResource(R.string.tunnel_intro_title))
                    }
                },
            )
        },
        bottomBar = {
            Button(
                onClick = finishSetup ?: done,
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .padding(16.dp)
                    .heightIn(min = 56.dp)
                    .testTag("tunnel:done"),
            ) {
                Text(
                    stringResource(
                        if (finishSetup != null) R.string.action_finish_setup else R.string.action_done,
                    ),
                )
            }
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (state.failed || settings == null) {
                item {
                    ListItem(
                        headlineContent = {
                            Text(stringResource(if (state.failed) R.string.state_error else R.string.state_loading))
                        },
                        supportingContent = state.error?.let { error ->
                            ({ Text(stringResource(tunnelSettingsError(error))) })
                        },
                        trailingContent = if (state.failed) ({
                            Button(onClick = { viewModel.refresh() }, modifier = Modifier.testTag("tunnel:retry")) {
                                Text(stringResource(R.string.action_retry))
                            }
                        }) else null,
                        modifier = Modifier.testTag("tunnel:load_state"),
                    )
                }
            }

            if (settings != null) {
                item {
                    ListItem(
                        headlineContent = { Text(stringResource(R.string.tunnel_mode)) },
                        leadingContent = { RowIcon(R.drawable.ic_cloud) },
                        supportingContent = {
                            Text(
                                stringResource(
                                    if (settings.mode == "named") R.string.tunnel_mode_named else R.string.tunnel_mode_quick,
                                ),
                            )
                        },
                        modifier = Modifier.testTag("tunnel:mode"),
                    )
                }

                item {
                    ListItem(
                        headlineContent = { Text(stringResource(R.string.tunnel_status)) },
                        leadingContent = { RowIcon(R.drawable.ic_monitor_heart) },
                        supportingContent = {
                            Column {
                                Text(stringResource(tunnelStateLabel(settings)))
                                settings.lastError?.let {
                                    Text(
                                        stringResource(R.string.tunnel_last_error, it),
                                        modifier = Modifier.testTag("tunnel:last_error"),
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                }
                            }
                        },
                        trailingContent = if (settings.state == TunnelRuntimeState.Failed) ({
                            Button(
                                onClick = { viewModel.setEnabled(true) },
                                modifier = Modifier.testTag("tunnel:runtime_retry"),
                            ) { Text(stringResource(R.string.action_retry)) }
                        }) else null,
                        modifier = Modifier.testTag("tunnel:status"),
                    )
                }

                item {
                    ListItem(
                        headlineContent = { Text(stringResource(R.string.tunnel_enable)) },
                        leadingContent = { RowIcon(R.drawable.ic_power) },
                        trailingContent = {
                            Switch(
                                checked = settings.enabled,
                                enabled = !state.loading,
                                onCheckedChange = { enabled ->
                                    if (enabled && shouldRequestNotifications()) {
                                        notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                                    } else {
                                        viewModel.setEnabled(enabled)
                                    }
                                },
                                modifier = Modifier.testTag("tunnel:enable"),
                            )
                        },
                    )
                }

                item {
                    ListItem(
                        headlineContent = { Text(stringResource(R.string.mcp_kill_switch)) },
                        leadingContent = { RowIcon(R.drawable.ic_verified_user) },
                        supportingContent = { Text(stringResource(R.string.mcp_kill_switch_body)) },
                        trailingContent = {
                            Switch(
                                checked = state.killed,
                                enabled = !state.loading,
                                onCheckedChange = { viewModel.setKilled(it) },
                                modifier = Modifier.testTag("tunnel:kill"),
                            )
                        },
                    )
                }

                if (settings.url != null) {
                    item {
                        ListItem(
                            headlineContent = { Text(stringResource(R.string.tunnel_base_url)) },
                            leadingContent = { RowIcon(R.drawable.ic_link) },
                            supportingContent = {
                                Text(settings.url, modifier = Modifier.testTag("tunnel:base_url"))
                            },
                            trailingContent = {
                                IconButton(
                                    onClick = { context.copyText(settings.url) },
                                    modifier = Modifier.testTag("tunnel:copy_base_url"),
                                ) {
                                    Icon(painterResource(R.drawable.ic_content_copy), stringResource(R.string.tunnel_copy_base_url))
                                }
                            },
                        )
                    }

                    val connectorUrl = settings.connectorUrl(state.token)
                    if (connectorUrl != null) {
                        item {
                            ListItem(
                                headlineContent = { Text(stringResource(R.string.tunnel_connector_url)) },
                                leadingContent = { RowIcon(R.drawable.ic_link) },
                                supportingContent = {
                                    Text(
                                        connectorUrl,
                                        modifier = Modifier.testTag("tunnel:connector_url"),
                                    )
                                },
                                trailingContent = {
                                    IconButton(
                                        onClick = { context.copyText(connectorUrl) },
                                        modifier = Modifier.testTag("tunnel:copy_connector_url"),
                                    ) {
                                        Icon(painterResource(R.drawable.ic_content_copy), stringResource(R.string.tunnel_copy_connector_url))
                                    }
                                },
                            )
                        }
                    }
                }

                item {
                    ListItem(
                        headlineContent = { Text(stringResource(R.string.mcp_access_token)) },
                        leadingContent = { RowIcon(R.drawable.ic_key) },
                        supportingContent = {
                            Text(state.token ?: "••••••••••••", modifier = Modifier.testTag("tunnel:token"))
                        },
                        trailingContent = {
                            TextButton(
                                onClick = { showRotateWarning = true },
                                modifier = Modifier.testTag("tunnel:rotate_token"),
                            ) {
                                Text(stringResource(R.string.action_regenerate))
                            }
                        },
                    )
                }

                item {
                    Card(
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                            .testTag("tunnel:checklist"),
                    ) {
                        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                stringResource(R.string.tunnel_checklist_title),
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text(
                                stringResource(R.string.tunnel_checklist_step1),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                stringResource(R.string.tunnel_checklist_step2),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(
                                stringResource(R.string.tunnel_checklist_step3),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                    }
                }

                item {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 4.dp)
                            .testTag("tunnel:operator_note"),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            stringResource(R.string.tunnel_operator_title),
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Text(
                            stringResource(R.string.tunnel_operator_curl_note),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                if (settings.mode == "quick") {
                    item {
                        Text(
                            stringResource(R.string.tunnel_quick_warning),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.outline,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                        )
                    }
                }
            }
        }
    }

    if (showRotateWarning) {
        AlertDialog(
            onDismissRequest = { showRotateWarning = false },
            title = { Text(stringResource(R.string.tunnel_rotate_title)) },
            text = { Text(stringResource(R.string.tunnel_rotate_warning)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.rotateToken { showRotateWarning = false }
                    },
                    modifier = Modifier.testTag("tunnel:confirm_rotate"),
                ) {
                    Text(stringResource(R.string.action_regenerate))
                }
            },
            dismissButton = {
                TextButton(onClick = { showRotateWarning = false }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }

    if (showIntro) {
        AlertDialog(
            onDismissRequest = { showIntro = false },
            title = { Text(stringResource(R.string.tunnel_intro_title)) },
            text = { Text(stringResource(R.string.tunnel_intro_body)) },
            confirmButton = {
                TextButton(onClick = { showIntro = false }) {
                    Text(stringResource(R.string.action_done))
                }
            },
        )
    }

    LaunchedEffect(Unit) {
        viewModel.refresh()
    }
}

fun tunnelStateLabel(settings: TunnelSettingsView?): Int = when (settings?.state) {
    TunnelRuntimeState.Connecting -> R.string.tunnel_state_connecting
    TunnelRuntimeState.Running -> R.string.tunnel_state_running
    TunnelRuntimeState.Failed -> R.string.task_state_failed
    TunnelRuntimeState.Stopped, null -> R.string.mcp_state_off
}

private fun tunnelSettingsError(error: TunnelSettingsError): Int = when (error) {
    TunnelSettingsError.TunnelNotFound -> R.string.reason_tunnel_not_found
    TunnelSettingsError.ApiKeyInvalid -> R.string.reason_tunnel_api_key_invalid
    TunnelSettingsError.OpenAiUnavailable -> R.string.reason_tunnel_openai_unavailable
    TunnelSettingsError.InvalidConfig -> R.string.reason_tunnel_invalid_config
    TunnelSettingsError.IoError -> R.string.reason_store_unavailable
    TunnelSettingsError.NotConfigured -> R.string.reason_tunnel_not_configured
}

private fun Context.copyText(text: String?) {
    if (text.isNullOrEmpty()) return
    runCatching {
        val cm = getSystemService(ClipboardManager::class.java)
        cm?.setPrimaryClip(ClipData.newPlainText("DroidBridge", text))
    }
}