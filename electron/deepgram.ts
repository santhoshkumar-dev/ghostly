import { ipcMain } from "electron";

/**
 * Deepgram credential handling — MAIN PROCESS ONLY.
 *
 * ── Why this file exists and why it is here ────────────────────────────────
 * The long-lived Deepgram API key must never be reachable from the renderer.
 * The renderer is a normal web context: it runs the React app, hosts a
 * DevTools console the user can open, and is therefore one `XSS`-grade slip
 * away from exfiltrating anything it can read. Every other provider key in this
 * app is already handled the same way, and Deepgram is no different.
 *
 * But Deepgram needs something the others do not: a WebSocket authenticates
 * via the `Sec-WebSocket-Protocol` header, NOT a custom `Authorization` header.
 * A browser `WebSocket` cannot set arbitrary headers at all, so the renderer
 * physically cannot present `Authorization: Token <key>`. There are exactly two
 * options:
 *
 *   a. Proxy the WebSocket through the main process, or
 *   b. Give the renderer a SHORT-LIVED token.
 *
 * This implements (b), which is Deepgram's own documented pattern for
 * exactly this case ("temporary tokens are ideal for real-time applications
 * requiring secure, temporary access"). The renderer holds a JWT with a
 * 30-second TTL and `usage::write` scope, minted on demand, used immediately to
 * open the socket, and then worthless. Deepgram confirms the socket stays open
 * past the token's expiry, so the short TTL costs nothing at runtime.
 *
 * The long-lived key is read from electron-store in THIS process and is never
 * sent over IPC, never returned to the renderer, and never logged.
 */

/** Deepgram's token-grant endpoint. */
const GRANT_URL = "https://api.deepgram.com/v1/auth/grant";

/**
 * Token TTL in seconds.
 *
 * Deepgram defaults to 30 s and allows up to 3600. 30 s is deliberately the
 * default: the token only has to survive the round trip that opens the socket,
 * and the shorter the window the less value there is to steal.
 */
export const TOKEN_TTL_SECONDS = 30;

/** Guard against a hung grant request wedging the renderer's connect path. */
const GRANT_TIMEOUT_MS = 8000;

export interface DeepgramTokenResult {
  /** Short-lived JWT. Safe to hold in renderer memory for seconds. */
  token: string;
  /** Seconds until expiry, as reported by Deepgram. */
  expiresIn: number;
}

export class DeepgramAuthError extends Error {
  constructor(
    message: string,
    readonly code: "no_key" | "grant_failed" | "timeout" | "unauthorized",
    /** HTTP status, when the failure came from the token endpoint. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "DeepgramAuthError";
  }
}

/**
 * Read the Deepgram API key.
 *
 * Read as a single top-level settings field rather than a whole-settings dump,
 * so the secret is never carried inside a larger object that could be logged or
 * serialised. Deliberately NOT `apiKeys.deepgram`: that map is the AI provider
 * chain, and Deepgram must never be reachable from it.
 */
export function readDeepgramKey(
  store: { get: (key: string) => unknown },
): string {
  const settings = store.get("settings") as
    | { deepgramKey?: string }
    | undefined;
  const key = settings?.deepgramKey;
  return typeof key === "string" ? key.trim() : "";
}

/**
 * Mint a short-lived token.
 *
 * The `Authorization` header is built here and never escapes this function's
 * scope except onto the outbound fetch. Errors are reported by CATEGORY with a
 * fixed message — Deepgram's error body can contain the request id and
 * provider detail, none of which should reach a log verbatim.
 */
export async function grantDeepgramToken(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeepgramTokenResult> {
  if (!apiKey) {
    throw new DeepgramAuthError(
      "No Deepgram API key configured.",
      "no_key",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRANT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(GRANT_URL, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl_seconds: TOKEN_TTL_SECONDS }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Log the STATUS only. The body may echo request context.
      const unauthorized = response.status === 401 || response.status === 403;
      console.warn(
        `[Deepgram] token grant failed with HTTP ${response.status}`,
      );
      if (unauthorized) {
        // A distinct, explicit developer diagnostic: a 401/403 here means the
        // credential was rejected, which is a DIFFERENT problem from a network
        // or quota failure. Deepgram comparison is optional, so this must never
        // affect Moonshine or Groq — it is a log line and a typed error only.
        console.warn(
          `[Deepgram] Deepgram unavailable: token request returned ${response.status}. The API key was rejected.`,
        );
      }
      throw new DeepgramAuthError(
        `Deepgram token grant failed (HTTP ${response.status}).`,
        unauthorized ? "unauthorized" : "grant_failed",
        response.status,
      );
    }

    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data?.access_token) {
      throw new DeepgramAuthError(
        "Deepgram token grant returned no access_token.",
        "grant_failed",
      );
    }

    return {
      token: data.access_token,
      expiresIn: typeof data.expires_in === "number" ? data.expires_in : TOKEN_TTL_SECONDS,
    };
  } catch (err) {
    if (err instanceof DeepgramAuthError) throw err;
    if (controller.signal.aborted) {
      throw new DeepgramAuthError(
        "Deepgram token grant timed out.",
        "timeout",
      );
    }
    // Never include the underlying message verbatim — it can contain the URL
    // and, on some paths, the request headers.
    console.warn("[Deepgram] token grant network error");
    throw new DeepgramAuthError(
      "Deepgram token grant failed to reach the API.",
      "grant_failed",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Register the IPC handlers.
 *
 * `deepgram:has-key` returns a BOOLEAN, never the key, so the renderer can
 * grey out the engine selector without ever holding the secret.
 */
export function registerDeepgramHandlers(
  store: { get: (key: string) => unknown },
): void {
  ipcMain.handle("deepgram:has-key", () => readDeepgramKey(store).length > 0);

  ipcMain.handle("deepgram:token", async () => {
    const key = readDeepgramKey(store);
    try {
      const result = await grantDeepgramToken(key);
      console.log(
        `[Deepgram] issued short-lived token (ttl=${result.expiresIn}s) — long-lived key stays in the main process`,
      );
      return { ok: true as const, token: result.token, expiresIn: result.expiresIn };
    } catch (err) {
      const code = err instanceof DeepgramAuthError ? err.code : "grant_failed";
      const status = err instanceof DeepgramAuthError ? err.status : undefined;
      // Fixed, non-leaking message per category. A rejected key gets an
      // explicit, distinct diagnostic so a 403 is never confused with a
      // network/timeout failure while debugging.
      return {
        ok: false as const,
        code,
        message:
          code === "no_key"
            ? "No Deepgram API key configured. Add one in Settings."
            : code === "unauthorized"
              ? `Deepgram unavailable: token request returned HTTP ${status ?? 401}. The API key was rejected — check it in Settings.`
              : "Could not obtain a Deepgram token. Check the key and connection.",
      };
    }
  });
}