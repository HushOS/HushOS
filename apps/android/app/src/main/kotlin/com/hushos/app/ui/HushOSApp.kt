package com.hushos.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Surface
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel

/* The gate, then Home, Files, Shared and Account as bottom tabs, as the cloud drives lay themselves out on a phone. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun HushOSApp(model: DriveViewModel = viewModel()) {
    val state by model.state.collectAsStateWithLifecycle()
    when (state.gate) {
        Gate.CHECKING -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingIndicator() }
        Gate.SIGNED_OUT -> SignInScreen(model, state)
        Gate.SIGNED_IN -> Column(Modifier.fillMaxSize()) {
            if (state.unreachable) OfflineBanner()
            Box(Modifier.weight(1f)) { Main(model, state) }
        }
    }
    state.error?.let { message ->
        AlertDialog(
            onDismissRequest = model::clearError,
            confirmButton = { TextButton(onClick = model::clearError) { Text("OK") } },
            title = { Text("Something went wrong") },
            text = { Text(message) },
        )
    }
}

private enum class Tab(val label: String) { HOME("Home"), FILES("Files"), SHARED("Shared"), ACCOUNT("Account") }

@Composable
private fun Main(model: DriveViewModel, state: DriveState) {
    var tab by rememberSaveable { mutableStateOf(Tab.HOME) }
    Scaffold(
        bottomBar = {
            NavigationBar {
                for (entry in Tab.entries) {
                    NavigationBarItem(
                        selected = tab == entry,
                        onClick = { tab = entry },
                        icon = {
                            Icon(
                                when (entry) {
                                    Tab.HOME -> Icons.Outlined.Home
                                    Tab.FILES -> Icons.Outlined.Folder
                                    Tab.SHARED -> Icons.Outlined.Group
                                    Tab.ACCOUNT -> Icons.Outlined.AccountCircle
                                },
                                contentDescription = entry.label,
                            )
                        },
                        label = { Text(entry.label) },
                    )
                }
            }
        },
        snackbarHost = {
            state.transfer?.let { transfer ->
                Snackbar(modifier = Modifier.padding(12.dp)) {
                    Column {
                        Text(transfer.title, style = MaterialTheme.typography.labelLarge)
                        LinearProgressIndicator(progress = { transfer.fraction }, modifier = Modifier.padding(top = 8.dp))
                    }
                }
            }
        },
    ) { padding ->
        Box(Modifier.padding(bottom = padding.calculateBottomPadding())) {
            when (tab) {
                Tab.HOME -> HomeScreen(model, state)
                Tab.FILES -> BrowseScreen(model, state)
                Tab.SHARED -> SharedScreen(model, state)
                Tab.ACCOUNT -> AccountScreen(model, state)
            }
        }
    }
}

/* A quiet line at the top while the server is out of reach; kept files still open. */
@Composable
private fun OfflineBanner() {
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer, modifier = Modifier.fillMaxWidth().statusBarsPadding()) {
        Text("You're offline. Showing what's on this phone.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
    }
}
