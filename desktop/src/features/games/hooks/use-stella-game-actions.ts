import { useMemo } from "react";
import { useReducer } from "spacetimedb/react";
import { reducers } from "@/features/games/bindings";

export function useStellaGameActions() {
  const createSession = useReducer(reducers.createSession);
  const joinSession = useReducer(reducers.joinSession);
  const leaveSession = useReducer(reducers.leaveSession);
  const startGame = useReducer(reducers.startGame);
  const endGame = useReducer(reducers.endGame);
  const pauseGame = useReducer(reducers.pauseGame);
  const submitAction = useReducer(reducers.submitAction);
  const updateSessionState = useReducer(reducers.updateSessionState);
  const createObject = useReducer(reducers.createObject);
  const updateObject = useReducer(reducers.updateObject);
  const removeObject = useReducer(reducers.removeObject);
  const updatePlayerScore = useReducer(reducers.updatePlayerScore);
  const updatePlayerPrivateState = useReducer(reducers.updatePlayerPrivateState);
  const sendChat = useReducer(reducers.sendChat);
  const gameTick = useReducer(reducers.gameTick);
  const startTickTimer = useReducer(reducers.startTickTimer);
  const stopTickTimer = useReducer(reducers.stopTickTimer);

  return useMemo(
    () => ({
      createSession,
      joinSession,
      leaveSession,
      startGame,
      endGame,
      pauseGame,
      submitAction,
      updateSessionState,
      createObject,
      updateObject,
      removeObject,
      updatePlayerScore,
      updatePlayerPrivateState,
      sendChat,
      gameTick,
      startTickTimer,
      stopTickTimer,
    }),
    [
      createObject,
      createSession,
      endGame,
      gameTick,
      joinSession,
      leaveSession,
      pauseGame,
      removeObject,
      sendChat,
      startGame,
      startTickTimer,
      stopTickTimer,
      submitAction,
      updateObject,
      updatePlayerPrivateState,
      updatePlayerScore,
      updateSessionState,
    ],
  );
}
