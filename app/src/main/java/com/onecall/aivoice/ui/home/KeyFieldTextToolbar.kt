package com.onecall.aivoice.ui.home

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.TextToolbar
import androidx.compose.ui.platform.TextToolbarStatus

/**
 * In-app replacement for the platform text toolbar (long-press 붙여넣기 menu), used only for the
 * API-key fields in the settings sheet.
 *
 * Why: with material3 1.2.x the ModalBottomSheet lives in its own popup window, where the
 * platform floating ActionMode (Android's copy/paste toolbar) cannot be started, so a long-press
 * in a TextField inside the sheet never shows "붙여넣기". This toolbar just records which actions
 * Compose offers; the key field renders them as a DropdownMenu (a Compose popup, which works there).
 */
class KeyFieldTextToolbar : TextToolbar {

    class Actions(
        val onCopy: (() -> Unit)?,
        val onPaste: (() -> Unit)?,
        val onCut: (() -> Unit)?,
        val onSelectAll: (() -> Unit)?
    ) {
        val isEmpty: Boolean get() = onCopy == null && onPaste == null && onCut == null && onSelectAll == null
    }

    /** Non-null while the menu should be visible. */
    var actions: Actions? by mutableStateOf(null)
        private set

    override val status: TextToolbarStatus
        get() = if (actions != null) TextToolbarStatus.Shown else TextToolbarStatus.Hidden

    override fun showMenu(
        rect: Rect,
        onCopyRequested: (() -> Unit)?,
        onPasteRequested: (() -> Unit)?,
        onCutRequested: (() -> Unit)?,
        onSelectAllRequested: (() -> Unit)?
    ) {
        val next = Actions(onCopyRequested, onPasteRequested, onCutRequested, onSelectAllRequested)
        actions = if (next.isEmpty) null else next
    }

    override fun hide() {
        actions = null
    }
}
