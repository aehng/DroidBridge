package com.droidbridge.ui.mcp

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.OutlinedTextField
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
import com.droidbridge.ui.product.mcp.RelaySettingsReplies
import com.droidbridge.ui.product.mcp.RelaySettingsView
import com.droidbridge.ui.product.mcp.RelayUiStatus
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
    val relay: RelaySettingsView? = null,
    val token: String? = null,
    val loading: Boolean = true,
    val failed: Boolean = false,
    val killed: Boolean = false,
    val pairError: String? = null,
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
            val relayReply = runCatching { client.relaySettings() }.getOrNull()
            val relay = relayReply?.let(RelaySettingsReplies::settings)
            val token = runCatching { client.revealMcpToken() }.getOrNull()?.let(McpSettingsReplies::token)
            val killed = runCatching { client.getVoiceKilled() }.getOrDefault(false)
            mutableState.update { current ->
                current.copy(
                    settings = settings ?: current.settings,
                    relay = relay ?: current.relay,
                    token = token ?: current.token,
                    killed = killed,
                    loading = if (background) current.loading else false,
                    failed = if (background) current.failed else relay == null && settings == null,
                    error = if (settings == null) reply?.let(TunnelSettingsReplies::error) else null,
                )
            }
        }
    }

    fun pair(code: String, relayBase: String) {
        viewModelScope.launch {
            mutableState.update { it.copy(loading = true, pairError = null) }
            val reply = runCatching { client.pairRelay(code, relayBase) }.getOrNull()
            val relay = reply?.let(RelaySettingsReplies::settings)
            mutableState.update { current ->
                current.copy(
                    relay = relay ?: current.relay,
                    loading = false,
                    pairError = if (relay == null) reply?.let(RelaySettingsReplies::error) else null,
                )
            }
        }
    }

    fun unpair() {
        viewModelScope.launch {
            val reply = runCatching { client.unpairRelay() }.getOrNull()
            val relay = reply?.let(RelaySettingsReplies::settings)
            mutableState.update { it.copy(relay = relay ?: it.relay) }
        }
    }

    fun setQuickFallback(enabled: Boolean) {
        viewModelScope.launch {
            runCatching { client.setQuickTunnelFallback(enabled) }
            refresh(background = true)
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

    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        viewModel.notificationsDecided()
        viewModel.setEnabled(true)
    }
    val settings = state.settings
    val relay = state.relay
    var pairCode by rememberSaveable { mutableStateOf("") }
    var relayBase by rememberSaveable { mutableStateOf(relay?.relayBase ?: "https://droid.synqra.info") }
    var showAdvancedBase by rememberSaveable { mutableStateOf(false) }
    var showQuickFallback by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(relay?.relayBase) {
        val base = relay?.relayBase
        if (!base.isNullOrEmpty()) relayBase = base
    }

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
            item {
                ListItem(
                    headlineContent = { Text(stringResource(R.string.relay_status)) },
                    leadingContent = { RowIcon(R.drawable.ic_monitor_heart) },
                    supportingContent = {
                        Column {
                            Text(stringResource(relayStatusLabel(relay)))
                            relay?.lastError?.let {
                                Text(
                                    stringResource(R.string.tunnel_last_error, it),
                                    modifier = Modifier.testTag("tunnel:last_error"),
                                    color = MaterialTheme.colorScheme.error,
                                )
                            }
                            state.pairError?.let {
                                Text(it, color = MaterialTheme.colorScheme.error)
                            }
                        }
                    },
                    modifier = Modifier.testTag("tunnel:status"),
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

            item {
                Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .testTag("relay:pair_steps"),
                ) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(stringResource(R.string.relay_pair_title), style = MaterialTheme.typography.titleMedium)
                        Text(stringResource(R.string.relay_pair_step1, (relay?.relayBase ?: relayBase).trimEnd('/') + "/pair"))
                        Text(stringResource(R.string.relay_pair_step2))
                    }
                }
            }

            if (relay?.paired != true) {
                item {
                    OutlinedTextField(
                        value = pairCode,
                        onValueChange = { pairCode = it.uppercase() },
                        label = { Text(stringResource(R.string.relay_pair_code)) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp)
                            .testTag("relay:code"),
                    )
                }
                item {
                    Button(
                        onClick = { viewModel.pair(pairCode, relayBase) },
                        enabled = !state.loading && pairCode.isNotBlank(),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp)
                            .testTag("relay:pair"),
                    ) { Text(stringResource(R.string.relay_pair_action)) }
                }
            } else {
                item {
                    Button(
                        onClick = viewModel::unpair,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp)
                            .testTag("relay:unpair"),
                    ) { Text(stringResource(R.string.relay_unpair_action)) }
                }
            }

            item {
                TextButton(
                    onClick = { showAdvancedBase = !showAdvancedBase },
                    modifier = Modifier.padding(horizontal = 8.dp).testTag("relay:advanced_base"),
                ) { Text(stringResource(R.string.relay_advanced_base_toggle)) }
            }
            if (showAdvancedBase) {
                item {
                    OutlinedTextField(
                        value = relayBase,
                        onValueChange = { relayBase = it },
                        label = { Text(stringResource(R.string.relay_base_url)) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp)
                            .testTag("relay:base"),
                    )
                }
            }

            val mcpUrl = relay?.mcpUrl ?: (relayBase.trimEnd('/') + "/mcp")
            item {
                ListItem(
                    headlineContent = { Text(stringResource(R.string.tunnel_connector_url)) },
                    leadingContent = { RowIcon(R.drawable.ic_link) },
                    supportingContent = {
                        Text(mcpUrl, modifier = Modifier.testTag("tunnel:connector_url"))
                    },
                    trailingContent = {
                        IconButton(
                            onClick = { context.copyText(mcpUrl) },
                            modifier = Modifier.testTag("tunnel:copy_connector_url"),
                        ) {
                            Icon(painterResource(R.drawable.ic_content_copy), stringResource(R.string.tunnel_copy_connector_url))
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
                        Text(stringResource(R.string.relay_chatgpt_title), style = MaterialTheme.typography.titleMedium)
                        Text(stringResource(R.string.relay_chatgpt_step1))
                        Text(stringResource(R.string.relay_chatgpt_step2, mcpUrl))
                        Text(stringResource(R.string.relay_chatgpt_step3))
                        Text(stringResource(R.string.relay_chatgpt_step4))
                    }
                }
            }

            item {
                TextButton(
                    onClick = { showQuickFallback = !showQuickFallback },
                    modifier = Modifier.padding(horizontal = 8.dp).testTag("relay:quick_toggle"),
                ) { Text(stringResource(R.string.relay_quick_fallback_toggle)) }
            }
            if (showQuickFallback) {
                item {
                    ListItem(
                        headlineContent = { Text(stringResource(R.string.relay_quick_fallback_enable)) },
                        trailingContent = {
                            Switch(
                                checked = relay?.quickTunnelFallback == true,
                                onCheckedChange = { enabled ->
                                    if (enabled && shouldRequestNotifications()) {
                                        notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                                    }
                                    viewModel.setQuickFallback(enabled)
                                    if (enabled) viewModel.setEnabled(true)
                                },
                                modifier = Modifier.testTag("tunnel:enable"),
                            )
                        },
                    )
                }
                if (settings?.url != null) {
                    item {
                        ListItem(
                            headlineContent = { Text(stringResource(R.string.tunnel_base_url)) },
                            supportingContent = { Text(settings.url, modifier = Modifier.testTag("tunnel:base_url")) },
                            trailingContent = {
                                IconButton(onClick = { context.copyText(settings.url) }) {
                                    Icon(painterResource(R.drawable.ic_content_copy), stringResource(R.string.tunnel_copy_base_url))
                                }
                            },
                        )
                    }
                }
            }
        }
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

fun relayStatusLabel(settings: RelaySettingsView?): Int = when (settings?.status) {
    RelayUiStatus.Connecting -> R.string.relay_status_connecting
    RelayUiStatus.Connected -> R.string.relay_status_connected
    RelayUiStatus.Offline -> R.string.relay_status_offline
    RelayUiStatus.Unpaired, null -> R.string.relay_status_unpaired
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