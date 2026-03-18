import { SpacetimeDBProvider } from "spacetimedb/react";
import App from "./App";
import { useGameConnectionBuilder } from "./hooks/useSpacetime";

export function AppRoot() {
  const connectionBuilder = useGameConnectionBuilder();

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  );
}
