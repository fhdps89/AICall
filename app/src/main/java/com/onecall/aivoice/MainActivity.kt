package com.onecall.aivoice

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.onecall.aivoice.ui.call.CallScreen
import com.onecall.aivoice.ui.home.HomeScreen
import com.onecall.aivoice.ui.theme.AICallTheme
import com.onecall.aivoice.ui.theme.HerAmber
import com.onecall.aivoice.ui.theme.HerBg
import com.onecall.aivoice.ui.theme.HerText
import com.onecall.aivoice.ui.theme.HerTextDim

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            AICallTheme {
                AppRoot()
            }
        }
    }
}

private object Routes {
    const val HOME = "home"
    const val CALL = "call"
}

@Composable
private fun AppRoot() {
    val context = LocalContext.current
    var hasMicPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED
        )
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasMicPermission = granted
    }

    LaunchedEffect(Unit) {
        if (!hasMicPermission) {
            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    if (!hasMicPermission) {
        PermissionGate(
            onRequest = { permissionLauncher.launch(Manifest.permission.RECORD_AUDIO) }
        )
        return
    }

    val navController = rememberNavController()
    NavHost(
        navController = navController,
        startDestination = Routes.HOME,
        modifier = Modifier
            .fillMaxSize()
            .background(HerBg)
    ) {
        composable(Routes.HOME) {
            HomeScreen(
                onStartCall = {
                    // Immediate Call screen — no voice picker
                    navController.navigate(Routes.CALL)
                }
            )
        }
        composable(Routes.CALL) {
            CallScreen(
                onHangUp = {
                    navController.popBackStack(Routes.HOME, inclusive = false)
                }
            )
        }
    }
}

@Composable
private fun PermissionGate(onRequest: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(HerBg)
            .padding(32.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = stringResource(R.string.permission_needed),
                style = MaterialTheme.typography.headlineMedium,
                color = HerText,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(12.dp))
            Text(
                text = "통화하려면 마이크 접근이 필요합니다.\n설정에서 허용해 주세요.",
                style = MaterialTheme.typography.bodyMedium,
                color = HerTextDim,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(24.dp))
            Button(
                onClick = onRequest,
                colors = ButtonDefaults.buttonColors(
                    containerColor = HerAmber,
                    contentColor = HerBg
                )
            ) {
                Text(stringResource(R.string.grant_permission))
            }
        }
    }
}
