/**
 * Fetch a remote image URL and return it as a base64 data URI.
 *
 * Used when upstream providers (Codex, etc.) require inline base64 images
 * instead of remote URLs they cannot fetch. Returns `null` if the input is
 * not an http(s) URL or the fetch fails for any reason, so callers can fall
 * back to the original value without throwing.
 */

export interface FetchImageAsBase64Options {
  /** External abort signal — when provided, the internal timeout is skipped. */
  signal?: AbortSignal;
  /** Timeout in milliseconds applied only when no external `signal` is given. */
  timeoutMs?: number;
}

export interface FetchedImage {
  /** `data:<mime>;base64,<payload>` data URI. */
  url: string;
  /** Resolved MIME type (defaults to `image/jpeg` when the server omits it). */
  mimeType: string;
}

/**
 * @param imageUrl HTTP(S) URL of the image.
 * @param options  Optional `signal` / `timeoutMs`.
 */
export async function fetchImageAsBase64(
  imageUrl: string | undefined | null,
  options: FetchImageAsBase64Options = {}
): Promise<FetchedImage | null> {
  const { signal, timeoutMs = 10000 } = options;
  if (!imageUrl || (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://"))) {
    return null;
  }

  const controller = new AbortController();
  const timeout = signal ? null : setTimeout(() => controller.abort(), timeoutMs);
  const fetchSignal = signal ?? controller.signal;

  try {
    const response = await fetch(imageUrl, { signal: fetchSignal });
    if (!response.ok) return null;

    const mimeType = response.headers.get("Content-Type") || "image/jpeg";
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    return { url: `data:${mimeType};base64,${base64}`, mimeType };
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
