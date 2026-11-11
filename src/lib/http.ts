/*
 * Minimal JSON client on top of the fetch API that ships with Node.js.
 *
 * Errors raised here never carry the request URL - the v1 API takes its key as a query
 * parameter, so a logged URL would leak it.
 */

/** Status and parsed body of a response, whatever the status was */
export interface JsonResponse {
    /** HTTP status code */
    status: number;
    /** the parsed JSON body, the plain text when it is not JSON, null when it is empty */
    data: any;
}

/** Options of a request */
export interface RequestOptions {
    /** HTTP method, GET when omitted */
    method?: 'GET' | 'POST';
    /** request headers */
    headers?: Record<string, string>;
    /** request body */
    body?: string;
    /** milliseconds until the request is aborted */
    timeout: number;
    /** `manual` hands a 3xx back instead of replaying the request to its target */
    redirect?: 'follow' | 'manual';
}

/** The server answered, but not with a success status */
export class HttpError extends Error {
    /**
     * @param status HTTP status code
     * @param data body of the response
     */
    public constructor(
        public readonly status: number,
        public readonly data: unknown,
    ) {
        super(`HTTP ${status}`);
        this.name = 'HttpError';
    }
}

/** The request never got an answer: DNS, connection, TLS or timeout */
export class NetworkError extends Error {
    /**
     * @param code error code like ENOTFOUND or TimeoutError, stable enough to compare
     * @param message human readable description
     */
    public constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'NetworkError';
    }
}

/**
 * Sends a request and parses the answer. Resolves for every HTTP status - the caller
 * decides what counts as an error - and throws a NetworkError when there is no answer.
 *
 * @param url the address to request
 * @param options method, headers, body, timeout and redirect handling
 */
export async function requestJson(url: string | URL, options: RequestOptions): Promise<JsonResponse> {
    let status: number;
    let text: string;

    try {
        const response = await fetch(url, {
            method: options.method ?? 'GET',
            headers: options.headers,
            body: options.body,
            redirect: options.redirect ?? 'follow',
            signal: AbortSignal.timeout(options.timeout),
        });

        status = response.status;
        text = await response.text();
    } catch (error: any) {
        if (error?.name === 'TimeoutError') {
            throw new NetworkError('TimeoutError', `no answer within ${options.timeout} ms`);
        }

        // fetch reports every connection problem as "fetch failed", the reason is in the cause
        const code = String(error?.cause?.code ?? error?.name ?? 'UNKNOWN');

        throw new NetworkError(code, `${error?.message ?? 'request failed'} (${code})`);
    }

    if (!text) {
        return { status, data: null };
    }

    try {
        return { status, data: JSON.parse(text) };
    } catch {
        // a proxy error page, for example - the caller gets it as text
        return { status, data: text };
    }
}
