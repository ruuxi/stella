import type { ReactNode } from "react";
import { SpacetimeDBProvider } from "spacetimedb/react";
import { useGameConnectionBuilder } from "@/features/games/hooks/use-game-connection-builder";

export function SpacetimeGamesProvider({
  children,
}: {
  children: ReactNode;
}) {
  const connectionBuilder = useGameConnectionBuilder();

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      {children}
    </SpacetimeDBProvider>
  );
}
