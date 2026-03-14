import { useMemo } from "react";
import { useReducer } from "spacetimedb/react";
import { reducers } from "@/features/games/bindings";

export function useStellaGameActions() {
  const registerPlayer = useReducer(reducers.registerPlayer);
  const createSession = useReducer(reducers.createSession);
  const joinSession = useReducer(reducers.joinSession);
  const leaveSession = useReducer(reducers.leaveSession);
  const startSession = useReducer(reducers.startSession);
  const pauseSession = useReducer(reducers.pauseSession);
  const resumeSession = useReducer(reducers.resumeSession);
  const endSession = useReducer(reducers.endSession);
  const configureSessionRuntime = useReducer(reducers.configureSessionRuntime);
  const updateSessionState = useReducer(reducers.updateSessionState);
  const spawnEntity = useReducer(reducers.spawnEntity);
  const updateEntityTransform = useReducer(reducers.updateEntityTransform);
  const despawnEntity = useReducer(reducers.despawnEntity);
  const upsertEntityComponent = useReducer(reducers.upsertEntityComponent);
  const removeEntityComponent = useReducer(reducers.removeEntityComponent);
  const upsertSessionResource = useReducer(reducers.upsertSessionResource);
  const removeSessionResource = useReducer(reducers.removeSessionResource);
  const emitSessionEvent = useReducer(reducers.emitSessionEvent);
  const submitInputFrame = useReducer(reducers.submitInputFrame);
  const captureSnapshot = useReducer(reducers.captureSnapshot);
  const pruneSnapshots = useReducer(reducers.pruneSnapshots);
  const assignPlayerPawn = useReducer(reducers.assignPlayerPawn);
  const updatePlayerPresence = useReducer(reducers.updatePlayerPresence);
  const adjustPlayerScore = useReducer(reducers.adjustPlayerScore);
  const upsertPrivateState = useReducer(reducers.upsertPrivateState);
  const removePrivateState = useReducer(reducers.removePrivateState);
  const startTickLoop = useReducer(reducers.startTickLoop);
  const stopTickLoop = useReducer(reducers.stopTickLoop);

  return useMemo(
    () => ({
      registerPlayer,
      createSession,
      joinSession,
      leaveSession,
      startSession,
      pauseSession,
      resumeSession,
      endSession,
      configureSessionRuntime,
      updateSessionState,
      spawnEntity,
      updateEntityTransform,
      despawnEntity,
      upsertEntityComponent,
      removeEntityComponent,
      upsertSessionResource,
      removeSessionResource,
      emitSessionEvent,
      submitInputFrame,
      captureSnapshot,
      pruneSnapshots,
      assignPlayerPawn,
      updatePlayerPresence,
      adjustPlayerScore,
      upsertPrivateState,
      removePrivateState,
      startTickLoop,
      stopTickLoop,
    }),
    [
      adjustPlayerScore,
      assignPlayerPawn,
      captureSnapshot,
      configureSessionRuntime,
      createSession,
      despawnEntity,
      emitSessionEvent,
      endSession,
      joinSession,
      leaveSession,
      pauseSession,
      pruneSnapshots,
      registerPlayer,
      removeEntityComponent,
      removePrivateState,
      removeSessionResource,
      resumeSession,
      spawnEntity,
      startSession,
      startTickLoop,
      stopTickLoop,
      submitInputFrame,
      updateEntityTransform,
      updatePlayerPresence,
      updateSessionState,
      upsertEntityComponent,
      upsertPrivateState,
      upsertSessionResource,
    ],
  );
}
