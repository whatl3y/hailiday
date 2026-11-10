import { isTerminalSourceUploadState, type PresignedPost, type UploadStatus } from './uploadState';

/**
 * Posts the photo straight to object storage with the presigned form: every policy field
 * first, then the file. Progress is the share of bytes sent, the only percentage the product
 * shows.
 */
export function postToStorage(
  post: PresignedPost,
  blob: Blob,
  fileName: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(post.fields)) form.append(key, value);
    form.append('file', blob, fileName);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', post.url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`storage ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('storage network'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

/** Polls the upload status until it is ready, declined or failed. */
export async function pollUploadStatus(
  fetchStatus: (signal: AbortSignal) => Promise<UploadStatus>,
  intervalMs: number,
  onUpdate: (status: UploadStatus) => void,
  signal: AbortSignal,
): Promise<UploadStatus> {
  let failures = 0;
  for (;;) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      const status = await fetchStatus(signal);
      failures = 0;
      onUpdate(status);
      if (isTerminalSourceUploadState(status.state)) return status;
    } catch (error) {
      if (signal.aborted) throw error;
      failures += 1;
      if (failures >= 5) throw error;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
