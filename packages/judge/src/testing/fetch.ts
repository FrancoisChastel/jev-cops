import type { FetchLike } from "../shared.ts";

/** One request a fake `fetch` received. */
export interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  /** The raw body text, exactly as it would have gone over the wire. */
  readonly text: string;
}

/** How the fake answers one request. */
export type Responder = (
  request: SentRequest,
  signal: AbortSignal | undefined,
) => Promise<Response>;

/** A JSON response. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A response that never arrives; rejects with an `AbortError` once `signal` fires. */
export function hang(_request: SentRequest, signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal?.aborted === true) abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** A fake `fetch` that records every request and answers with `respond`. */
export function fakeFetch(respond: Responder): { fetch: FetchLike; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const fetch: FetchLike = (url, init) => {
    const request: SentRequest = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      text: typeof init?.body === "string" ? init.body : "",
    };
    sent.push(request);
    return respond(request, init?.signal ?? undefined);
  };
  return { fetch, sent };
}
