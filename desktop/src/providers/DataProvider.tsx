/**
 * DataProvider — mode-aware provider that abstracts local vs cloud data access.
 *
 * In local mode: queries go to the local HTTP server
 * In cloud mode: queries go to Convex (unchanged behavior)
 */

import React, { createContext, useContext, useEffect, useState } from "react";
import { isLocalMode, setLocalPort, LocalSSEClient } from "@/services/local-client";

type DataMode = "local" | "cloud";

type DataContextValue = {
  mode: DataMode;
  localPort: number;
  sseClient: LocalSSEClient | null;
  switchConversation: (conversationId: string) => void;
};

const DataContext = createContext<DataContextValue>({
  mode: "cloud",
  localPort: 9714,
  sseClient: null,
  switchConversation: () => {},
});

export function useDataMode(): DataContextValue {
  return useContext(DataContext);
}

export function useIsLocalMode(): boolean {
  return useContext(DataContext).mode === "local";
}

type DataProviderProps = {
  mode?: DataMode;
  children: React.ReactNode;
};

export function DataProvider({ mode: modeProp, children }: DataProviderProps) {
  const [mode] = useState<DataMode>(() => {
    if (modeProp) return modeProp;
    return isLocalMode() ? "local" : "cloud";
  });

  const [localPort, setPort] = useState(9714);
  const [sseClient, setSseClient] = useState<LocalSSEClient | null>(null);

  // Initialize local mode
  useEffect(() => {
    if (mode !== "local") return;

    // Get local server port from Electron
    const initPort = async () => {
      try {
        const api = (window as unknown as { electronAPI?: { getLocalServerPort?: () => Promise<number> } }).electronAPI;
        if (api?.getLocalServerPort) {
          const port = await api.getLocalServerPort();
          setPort(port);
          setLocalPort(port);
        }
      } catch {
        // Use default port
      }
    };

    initPort();
  }, [mode]);

  // Create SSE client for local mode
  useEffect(() => {
    if (mode !== "local") return;

    const client = new LocalSSEClient("default");
    setSseClient(client);

    return () => {
      client.disconnect();
    };
  }, [mode]);

  const switchConversation = (conversationId: string) => {
    if (sseClient) {
      sseClient.switchConversation(conversationId);
      sseClient.connect();
    }
  };

  return (
    <DataContext.Provider value={{ mode, localPort, sseClient, switchConversation }}>
      {children}
    </DataContext.Provider>
  );
}
