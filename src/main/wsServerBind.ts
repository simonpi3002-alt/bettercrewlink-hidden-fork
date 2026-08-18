// Simon's Among Us: bounded-retry WS server bind helper, split out of
// controlBridge.ts so the retry state machine can be exercised by a plain
// Node test harness without pulling in Electron (controlBridge.ts itself
// imports `ipcMain`, which only exists inside an Electron process). No
// Electron API is used below -- only `ws`.
//
// Real bug this replaces, 2026-08-18: controlBridge.ts used to do
// `server = new WS.Server(...)` immediately, then only logged on a later
// 'error' event (e.g. EADDRINUSE). Because `ws`/`net` bind asynchronously,
// `server` was already non-null by the time that error fired, and the
// caller's `if (server) return;` guard then silently no-op'd every future
// startControlBridge() call forever -- no retry, and no way to recover
// without restarting the whole process.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WS = require('ws');

export interface BoundedBindOptions {
	host: string;
	port: number;
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	onAttempt?: (attempt: number, maxAttempts: number) => void;
	onRetryScheduled?: (attempt: number, maxAttempts: number, delayMs: number, err: Error) => void;
	onGaveUp?: (maxAttempts: number, err: Error) => void;
}

export interface BoundedBindHandle {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	promise: Promise<any>;
	cancel: () => void;
}

// Binds a `ws` server with a bounded number of attempts and exponential
// backoff (capped) between them. Resolves with the bound server instance on
// success, or `null` once every attempt has been exhausted (or `cancel()`
// was called) -- never rejects, and never spins a tight/infinite loop.
export function bindWsServerWithRetry(options: BoundedBindOptions): BoundedBindHandle {
	const { host, port } = options;
	const maxAttempts = options.maxAttempts ?? 5;
	const baseDelayMs = options.baseDelayMs ?? 500;
	const maxDelayMs = options.maxDelayMs ?? 8000;

	let attempt = 0;
	let cancelled = false;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let resolvePromise: (value: any) => void;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const promise = new Promise<any>((resolve) => {
		resolvePromise = resolve;
		attemptBind();
	});

	function attemptBind(): void {
		if (cancelled) {
			return;
		}
		attempt += 1;
		options.onAttempt?.(attempt, maxAttempts);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const candidate: any = new WS.Server({ host, port });

		const onListening = () => {
			candidate.removeListener('error', onError);
			if (cancelled) {
				// A cancel() landed between construction and the async
				// 'listening' event -- don't hand back a live server nobody
				// asked for anymore; close what we just opened.
				candidate.close();
				resolvePromise(null);
				return;
			}
			resolvePromise(candidate);
		};

		const onError = (err: Error) => {
			candidate.removeListener('listening', onListening);
			// The failed instance must not leak a half-open handle -- close
			// it before trying again so a stale listener can't keep holding
			// the port (or a file descriptor) across attempts.
			try {
				candidate.close();
			} catch {
				// already dead; nothing to clean up
			}

			if (cancelled) {
				resolvePromise(null);
				return;
			}

			if (attempt >= maxAttempts) {
				options.onGaveUp?.(maxAttempts, err);
				resolvePromise(null);
				return;
			}

			const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
			options.onRetryScheduled?.(attempt, maxAttempts, delayMs, err);
			retryTimer = setTimeout(attemptBind, delayMs);
		};

		candidate.once('listening', onListening);
		candidate.once('error', onError);
	}

	return {
		promise,
		cancel: () => {
			cancelled = true;
			if (retryTimer) {
				clearTimeout(retryTimer);
				retryTimer = null;
			}
		},
	};
}
