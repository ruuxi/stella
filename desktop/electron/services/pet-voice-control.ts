import type { PetWindowController } from "../windows/pet-window.js";
import type { UiStateService } from "./ui-state-service.js";
import type { WindowManager } from "../windows/window-manager.js";
import { IPC_PET_SET_OPEN } from "../../src/shared/contracts/ipc-channels.js";

type PetVoiceControlDeps = {
  uiStateService: UiStateService;
  getPetController: () => PetWindowController | null;
  windowManager: WindowManager;
};

let petOpenedByCurrentVoiceSession = false;

const broadcastPetOpen = (windowManager: WindowManager, open: boolean) => {
  for (const window of windowManager.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(IPC_PET_SET_OPEN, open);
  }
};

export const cleanupPetVoiceSession = ({
  getPetController,
  windowManager,
}: Pick<PetVoiceControlDeps, "getPetController" | "windowManager">) => {
  if (!petOpenedByCurrentVoiceSession) return;
  petOpenedByCurrentVoiceSession = false;
  getPetController()?.setOpen(false);
  broadcastPetOpen(windowManager, false);
};

/**
 * Single source of truth for "go to voice mode now".
 *
 * Voice no longer has its own creature overlay — instead, we always
 * open the floating pet (whose sprite animates listening / speaking
 * from `voice:runtimeState`) and toggle the realtime voice session.
 * Every activation path (the global keybind, the radial dial's voice
 * wedge, and the pet's own mic action button) routes through this
 * function so the behaviour stays identical.
 */
export const togglePetVoice = (deps: PetVoiceControlDeps) => {
  const { uiStateService: ui, getPetController, windowManager } = deps;
  if (ui.state.isVoiceRtcActive) {
    ui.deactivateVoiceModes();
    return;
  }

  // Show the pet first so the user has something to look at the
  // moment voice activates (and so the renderer's voice-state
  // subscription is mounted by the time runtime events start
  // arriving).
  const pet = getPetController();
  if (pet) {
    petOpenedByCurrentVoiceSession = !pet.isVisible();
    pet.setOpen(true);
    // Broadcast so any other window's `pet:setOpen` subscribers
    // (e.g. the settings page toggle button) see the new state.
    broadcastPetOpen(windowManager, true);
  } else {
    petOpenedByCurrentVoiceSession = false;
  }

  ui.activateVoiceRtc(ui.state.conversationId);
};
