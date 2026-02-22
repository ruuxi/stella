import React, { createContext, useContext, useMemo } from "react";

type DataMode = "cloud";

type DataContextValue = {
  mode: DataMode;
};

const DataContext = createContext<DataContextValue>({
  mode: "cloud",
});

export function useDataMode(): DataContextValue {
  return useContext(DataContext);
}

export function useIsLocalMode(): boolean {
  return false;
}

type DataProviderProps = {
  mode?: "cloud";
  children: React.ReactNode;
};

export function DataProvider({ children }: DataProviderProps) {
  const value = useMemo<DataContextValue>(
    () => ({
      mode: "cloud",
    }),
    [],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
