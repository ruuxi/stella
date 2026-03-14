import React from "react";
import ReactDOM from "react-dom/client";
import { SpacetimeDBProvider } from "spacetimedb/react";
import App from "./App";
import { useGameConnectionBuilder } from "./hooks/useSpacetime";

function Root() {
  const connectionBuilder = useGameConnectionBuilder();

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
