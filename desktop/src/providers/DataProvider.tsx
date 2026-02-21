/**
 * DataProvider - mode-aware provider that abstracts local vs cloud data access.
 *
 * In local mode: queries go to the local HTTP server.
 * In cloud mode: queries go to Convex.
 */

import React, { createContext, useContext, useEffect, useState } from "react";
import { useConvexAuth } from "convex/react";
import {
  isElectronRuntime,
  setLocalPort,
  LocalSSEClient,
  readCachedDataMode,
  writeCachedDataMode,
} from "@/services/local-client";

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
  const { isAuthenticated, isLoading } = useConvexAuth();
  const electronLocalHost = isElectronRuntime();

  const [mode, setMode] = useState<DataMode>(() => {
    if (modeProp) return modeProp;
    if (!electronLocalHost) return "cloud";
    return readCachedDataMode() ?? "local";
  });

  const [localPort, setPort] = useState(9714);
  const [sseClient, setSseClient] = useState<LocalSSEClient | null>(null);

  useEffect(() => {
    let nextMode: DataMode;

    if (modeProp) {
      nextMode = modeProp;
    } else if (!electronLocalHost) {
      nextMode = "cloud";
    } else if (isLoading) {
      return;
    } else {
      nextMode = isAuthenticated ? "cloud" : "local";
      writeCachedDataMode(nextMode);
    }

    if (nextMode !== mode) {
      setMode(nextMode);
    }
  }, [mode, modeProp, electronLocalHost, isAuthenticated, isLoading]);

  // Initialize local mode
  useEffect(() => {
    if (mode !== "local") return;

    // Get local server port from Electron
    const initPort = async () => {
      try {
        const electronApi = (
          window as unknown as {
            electronAPI?: { getLocalServerPort?: () => Promise<number> };
          }
        ).electronAPI;
        if (electronApi?.getLocalServerPort) {
          const port = await electronApi.getLocalServerPort();
          setPort(port);
          setLocalPort(port);
        }
      } catch {
        // Use default port
      }
    };

    void initPort();
  }, [mode]);

  // Create SSE client for local mode
  useEffect(() => {
    if (mode !== "local") return;

    const client = new LocalSSEClient("default");
    setSseClient(client);

    return () => {
      client.disconnect();
      setSseClient(null);
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
