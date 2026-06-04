import { createContext, useContext } from "react";
import type { ReactNode } from "react";

export type ChatStorageMode = "cloud" | "local";

export type ChatStoreContextValue = {
  storageMode: ChatStorageMode;
  isLocalStorage: boolean;
  cloudFeaturesEnabled: boolean;
  isAuthenticated: boolean;
};

const ChatStoreContext = createContext<ChatStoreContextValue | null>(null);

const LOCAL_CHAT_STORE_VALUE: ChatStoreContextValue = {
  storageMode: "local",
  isLocalStorage: true,
  cloudFeaturesEnabled: false,
  isAuthenticated: false,
};

export const ChatStoreContextProvider = ({
  children,
  value,
}: {
  children: ReactNode;
  value: ChatStoreContextValue;
}) => (
  <ChatStoreContext.Provider value={value}>{children}</ChatStoreContext.Provider>
);

export const LocalChatStoreProvider = ({ children }: { children: ReactNode }) => (
  <ChatStoreContextProvider value={LOCAL_CHAT_STORE_VALUE}>
    {children}
  </ChatStoreContextProvider>
);

export const useChatStore = () => {
  const context = useContext(ChatStoreContext);
  if (!context) {
    throw new Error("useChatStore must be used within ChatStoreProvider");
  }
  return context;
};
