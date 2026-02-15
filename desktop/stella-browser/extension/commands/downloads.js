/**
 * Download command handler.
 * Uses chrome.downloads API.
 */

export async function handleDownload(command) {
  const url = command.url;
  if (!url) throw new Error('URL is required for download');

  const downloadId = await chrome.downloads.download({
    url,
    filename: command.filename || undefined,
    saveAs: false,
  });

  // Wait for download to complete
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      reject(new Error('Download timed out after 60s'));
    }, 60000);

    function listener(delta) {
      if (delta.id !== downloadId) return;

      if (delta.state?.current === 'complete') {
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(listener);
        chrome.downloads.search({ id: downloadId }, (results) => {
          const item = results?.[0];
          resolve({
            id: command.id,
            success: true,
            data: {
              path: item?.filename || '',
              suggestedFilename: item?.filename?.split(/[/\\]/).pop() || '',
              fileSize: item?.fileSize || 0,
            },
          });
        });
      }

      if (delta.error) {
        clearTimeout(timeout);
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error(`Download failed: ${delta.error.current}`));
      }
    }

    chrome.downloads.onChanged.addListener(listener);
  });
}
