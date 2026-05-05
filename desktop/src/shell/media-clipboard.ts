const blobToPngBlob = (blob: Blob): Promise<Blob> =>
  new Promise((resolve, reject) => {
    if (blob.type === "image/png") {
      resolve(blob);
      return;
    }

    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("Could not encode image"));
        return;
      }

      ctx.drawImage(img, 0, 0);
      canvas.toBlob((next) => {
        URL.revokeObjectURL(url);
        if (next) {
          resolve(next);
        } else {
          reject(new Error("Could not encode image"));
        }
      }, "image/png");
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not load image for copy"));
    };

    img.src = url;
  });

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const copyImageBlob = async (blob: Blob): Promise<void> => {
  const pngBase64 = await blobToBase64(await blobToPngBlob(blob));
  const result = await window.electronAPI?.media?.copyImage?.(pngBase64);
  if (!result?.ok) throw new Error(result?.error ?? "Could not copy");
};
