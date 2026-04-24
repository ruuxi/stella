import { useEffect, useMemo, useState } from "react";

type DisplayFileReadResult = {
  contentsBase64: string;
  sizeBytes: number;
  mimeType: string;
};

export type DisplayFileBlob = {
  url: string;
  mimeType: string;
  blob: Blob;
};

export const isDisplayFileApiAvailable = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.electronAPI?.display?.readFile === "function";

export const decodeBase64ToUint8Array = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

export const decodeBase64ToBlob = (base64: string, mimeType: string): Blob => {
  const decoded = decodeBase64ToUint8Array(base64);
  // Allocate an `ArrayBuffer` (not `SharedArrayBuffer`) so BlobPart stays
  // compatible with TS strict DOM typings.
  const buffer = new ArrayBuffer(decoded.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(decoded);
  return new Blob([buffer], {
    type: mimeType || "application/octet-stream",
  });
};

export const readDisplayFile = async (
  filePath: string,
  unavailableMessage?: string,
): Promise<DisplayFileReadResult> => {
  if (!isDisplayFileApiAvailable()) {
    throw new Error(
      unavailableMessage ?? "File preview requires the Electron host runtime.",
    );
  }
  return await window.electronAPI!.display.readFile(filePath);
};

export function useDisplayFileBytes(
  filePath: string,
  unavailableMessage?: string,
) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBytes(null);

    void (async () => {
      try {
        const result = await readDisplayFile(filePath, unavailableMessage);
        if (cancelled) return;
        setBytes(decodeBase64ToUint8Array(result.contentsBase64));
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filePath, unavailableMessage]);

  return { bytes, error, loading };
}

export function useDisplayFileBlobs(
  filePaths: string[],
  unavailableMessage?: string,
) {
  const [files, setFiles] = useState<(DisplayFileBlob | null)[]>(() =>
    filePaths.map(() => null),
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const key = useMemo(() => filePaths.join("|"), [filePaths]);

  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];
    setLoading(true);
    setError(null);
    setFiles(filePaths.map(() => null));

    void (async () => {
      const results = await Promise.all(
        filePaths.map(async (filePath): Promise<DisplayFileBlob | null> => {
          try {
            const result = await readDisplayFile(filePath, unavailableMessage);
            const blob = decodeBase64ToBlob(
              result.contentsBase64,
              result.mimeType,
            );
            const url = URL.createObjectURL(blob);
            createdUrls.push(url);
            return { url, mimeType: result.mimeType, blob };
          } catch (caught) {
            if (!cancelled) {
              setError(caught instanceof Error ? caught.message : String(caught));
            }
            return null;
          }
        }),
      );
      if (cancelled) {
        for (const url of createdUrls) URL.revokeObjectURL(url);
        return;
      }
      setFiles(results);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
    // `filePaths` reference changes on every render, so key off contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, unavailableMessage]);

  return { files, error, loading };
}
