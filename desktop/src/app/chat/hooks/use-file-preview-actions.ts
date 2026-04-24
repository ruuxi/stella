import { useCallback, useState } from "react";

type UseFilePreviewActionsOptions = {
  sourcePath: string;
  suggestedName: string;
};

export const useFilePreviewActions = ({
  sourcePath,
  suggestedName,
}: UseFilePreviewActionsOptions) => {
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    const result = await window.electronAPI?.system?.saveFileAs?.(
      sourcePath,
      suggestedName,
    );
    if (!result || result.canceled) return;
    setActionStatus(result.ok ? "Saved" : (result.error ?? "Could not save"));
  }, [sourcePath, suggestedName]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(sourcePath);
    setActionStatus("Copied");
  }, [sourcePath]);

  return {
    actionStatus,
    handleSave,
    handleCopy,
  };
};
