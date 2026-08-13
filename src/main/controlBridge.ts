// Simon's Among Us Stage 2 experiment: minimal local control bridge
// prototype. Loopback-only WebSocket exposing a narrow, primitive
// command/state schema -- deliberately NOT a dump of BetterCrewLink's
// internal state objects (Voice.tsx's AmongUsState, ISettings, WebRTC peer
// objects, etc.), per the Stage 0 GPLv3 boundary analysis: the license
// interpretation there specifically depends on this bridge staying a
// narrow, well-defined command/state surface, not "exchanging complex
// internal data structures."
//
// This is a PROTOTYPE for empirical validation only (does a loopback
// bridge work reliably, what's the round-trip latency). It does not yet
// read or drive Voice.tsx's real mute/connection/speaking state -- that
// wiring is real Stage 5 implementation work, not this throwaway
// experiment. State pushed here is a simple heartbeat with a monotonic
// counter, not real voice state.
//
// Plain CommonJS require (not an ES/TS import) deliberately: electron-webpack
// marks node_modules as externals for the main-process bundle, and this
// specific combination of old ts-loader + webpack 4 externals handling did
// not correctly resolve TS's `import X = require()` syntax for this module
// in this build environment -- a real, if uninteresting, toolchain quirk of
// this decommissioned build stack, not a design decision to carry forward.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WS = require('ws');

export const CONTROL_BRIDGE_PORT = 45397;

interface BridgeCommand {
	command: string;
	requestId?: string;
	[key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any = null;
let heartbeat: NodeJS.Timeout | null = null;
let counter = 0;

export function startControlBridge(): void {
	if (server) {
		return;
	}

	// Loopback-only: explicit host binding, never 0.0.0.0 -- per
	// BETTERCREWLINK_LICENSING_AND_PRIVACY.md's security requirement for
	// any local control surface this architecture introduces.
	server = new WS.Server({ host: '127.0.0.1', port: CONTROL_BRIDGE_PORT });
	console.log(`[control-bridge] listening on ws://127.0.0.1:${CONTROL_BRIDGE_PORT}`);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.on('connection', (socket: any) => {
		console.log('[control-bridge] client connected');

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		socket.on('message', (raw: any) => {
			let parsed: BridgeCommand;
			try {
				parsed = JSON.parse(raw.toString());
			} catch {
				socket.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
				return;
			}
			// Treat all incoming data as untrusted input, even though the
			// realistic "attacker" model here is just another local process --
			// per the licensing study's stated design requirement.
			if (typeof parsed !== 'object' || parsed === null || typeof parsed.command !== 'string') {
				socket.send(JSON.stringify({ type: 'error', message: 'malformed command' }));
				return;
			}
			console.log(`[control-bridge] received command: ${parsed.command}`, parsed);
			// Prototype only: echo an ack with server-side receive time so the
			// test client can measure real round-trip latency. Real command
			// handling (actually toggling mute against Voice.tsx's state) is
			// Stage 5 implementation work.
			socket.send(JSON.stringify({
				type: 'ack',
				command: parsed.command,
				requestId: parsed.requestId,
				receivedAtMs: Date.now()
			}));
		});

		socket.on('close', () => console.log('[control-bridge] client disconnected'));
	});

	server.on('error', (err: Error) => console.log('[control-bridge] server error:', err.message));

	// Prototype-only fake state push -- a real implementation reports real
	// connection/mute/speaking state from Voice.tsx via IPC into main, not a
	// counter. This exists only to prove the push-to-multiple-clients path
	// (Launcher Voice tab + future CoreMod overlay, per Phase 13B's "multiple
	// simultaneous local clients" bridge requirement) works end to end.
	heartbeat = setInterval(() => {
		counter += 1;
		const state = JSON.stringify({ type: 'state', counter, atMs: Date.now() });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		server.clients.forEach((client: any) => {
			if (client.readyState === WS.OPEN) {
				client.send(state);
			}
		});
	}, 1000);
}

export function stopControlBridge(): void {
	if (heartbeat) {
		clearInterval(heartbeat);
		heartbeat = null;
	}
	server?.close();
	server = null;
}
