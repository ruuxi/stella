import type { ReactNode } from "react";
import { SpacetimeDBProvider } from "spacetimedb/react";
import { useGameConnectionBuilder } from "@/features/games/hooks/use-game-connection-builder";
import { useRegisterGamePlayer } from "@/features/games/hooks/use-register-game-player";

function GamePlayerRegistrationBridge() {
  useRegisterGamePlayer();
  return null;
}

export function SpacetimeGamesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const connectionBuilder = useGameConnectionBuilder();

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <GamePlayerRegistrationBridge />
      {children}
    </SpacetimeDBProvider>
  );
}
