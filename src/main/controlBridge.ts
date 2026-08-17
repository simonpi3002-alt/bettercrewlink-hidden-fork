// Simon's Among Us: local control bridge. Loopback-only WebSocket exposing
// a narrow, primitive command/state schema -- deliberately NOT a dump of
// BetterCrewLink's internal state objects (Voice.tsx's AmongUsState,
// ISettings, WebRTC peer objects, etc.), per the Stage 0 GPLv3 boundary
// analysis: the license interpretation there specifically depends on this
// bridge staying a narrow, well-defined command/state surface, not
// "exchanging complex internal data structures." See
// src/common/ControlBridgeState.ts for the shared wire type.
//
// Commands are forwarded to the renderer via the exact same IPC channels a
// physical keyboard shortcut uses (see src/main/hook.ts's TOGGLE_MUTE/
// TOGGLE_DEAFEN sends) -- no parallel mute/deafen/device-switching logic
// lives here. Voice/device state is pushed here unconditionally by the
// renderer (src/renderer/Voice.tsx, via IpcMessages.SEND_TO_CONTROL_BRIDGE)
// and broadcast to every connected bridge client. Broadcasting to
// `server.clients` rather than a single socket means a second simultaneous
// client can connect and receive the same state without any protocol
// change -- exercised for real as of Phase 13B, which added the in-game
// CoreMod overlay as a second bridge client alongside the Launcher Voice
// tab from Phase 13.
//
// MULTI-CLIENT ARBITRATION RULE (Phase 13B): last-write-wins with broadcast
// reconciliation, enforced by construction, not by anything in this file
// picking a "winner." Every command (from either client) mutates exactly
// one shared piece of state living in Voice.tsx -- there is no per-client
// copy anywhere to go out of sync. Whichever command Node's single-threaded
// event loop processes last is authoritative; the resulting real state then
// broadcasts to every connected client (including whichever one "lost" a
// near-simultaneous race), so every client's display converges to the same
// truth within one broadcast, every time. This requires bridge CLIENTS to
// hold up their end: a client must render only from the last state
// broadcast it received, never from its own optimistic guess about what a
// command it just sent will do -- both VoiceBridgeClient (Launcher) and
// OverlayBridgeClient (CoreMod) are written this way. No sequence numbers
// or command IDs are needed for correctness: each client holds exactly one
// ordered WebSocket connection, so reordering across a single connection
// isn't a real risk here.
//
// Plain CommonJS require (not an ES/TS import) deliberately: electron-webpack
// marks node_modules as externals for the main-process bundle, and this
// specific combination of old ts-loader + webpack 4 externals handling did
// not correctly resolve TS's `import X = require()` syntax for this module
// in this build environment -- a real, if uninteresting, toolchain quirk of
// this decommissioned build stack, not a design decision to carry forward.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WS = require('ws');
import { ipcMain } from 'electron';
import { IpcMessages, IpcRendererMessages } from '../common/ipc-messages';
import { ControlBridgeVoiceState } from '../common/ControlBridgeState';

export const CONTROL_BRIDGE_PORT = 45397;

interface BridgeCommand {
	command: string;
	requestId?: string;
	deviceId?: string;
	[key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any = null;
let lastKnownState: ControlBridgeVoiceState | null = null;
let ipcListenerRegistered = false;
let connectedClientCount = 0;

// Real find, 2026-08-17: no 'error' listener was ever attached to an
// individual client socket below. Node's EventEmitter throws a socket's
// 'error' event as an uncaught exception (crashing the ENTIRE process,
// historically Node's documented default for an EventEmitter 'error' with
// no listener) if nothing is listening for it -- a single TCP-level hiccup
// on ANY connected client's loopback socket (either of Simon's Among Us's
// two bridge clients: the Launcher's VoiceBridgeClient or CoreMod's
// OverlayBridgeClient) could have silently killed this entire hidden,
// show:false Electron process. That would explain the live-tested symptom
// exactly: minutes-long or permanently unreachable reconnect attempts (the
// whole process, not just the listener, is gone) and the workaround that
// actually fixed it every time (killing and restarting BetterCrewLink --
// there is no other way to recover from a crashed process). The two fixes
// below (this explicit per-socket handler, and index.ts's new global
// process.on('uncaughtException') safety net) both independently prevent
// this exact crash from now on.

function sendState(state: ControlBridgeVoiceState): void {
	lastKnownState = state;
	broadcast({ type: 'state', atMs: Date.now(), voice: state });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function broadcast(payload: unknown): void {
	if (!server) {
		return;
	}
	const json = JSON.stringify(payload);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	server.clients.forEach((client: any) => {
		if (client.readyState === WS.OPEN) {
			client.send(json);
		}
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleCommand(socket: any, parsed: BridgeCommand): void {
	console.log(`[control-bridge] received command: ${parsed.command}`, parsed);

	switch (parsed.command) {
		case 'toggleMute':
			global.mainWindow?.webContents.send(IpcRendererMessages.TOGGLE_MUTE);
			break;
		case 'toggleDeafen':
			global.mainWindow?.webContents.send(IpcRendererMessages.TOGGLE_DEAFEN);
			break;
		case 'setMicrophone':
			if (typeof parsed.deviceId === 'string') {
				global.mainWindow?.webContents.send(IpcRendererMessages.SET_MICROPHONE, parsed.deviceId);
			}
			break;
		case 'setSpeaker':
			if (typeof parsed.deviceId === 'string') {
				global.mainWindow?.webContents.send(IpcRendererMessages.SET_SPEAKER, parsed.deviceId);
			}
			break;
		default:
			socket.send(JSON.stringify({ type: 'error', message: `unknown command: ${parsed.command}` }));
			return;
	}

	// Real command handling above already ran; the ack just confirms receipt
	// and gives the caller a round-trip timestamp -- the renderer's own
	// SEND_TO_CONTROL_BRIDGE report (not this ack) is the source of truth
	// for whether the command actually changed anything.
	socket.send(JSON.stringify({
		type: 'ack',
		command: parsed.command,
		requestId: parsed.requestId,
		receivedAtMs: Date.now()
	}));
}

export function startControlBridge(): void {
	if (!ipcListenerRegistered) {
		ipcListenerRegistered = true;
		ipcMain.on(IpcMessages.SEND_TO_CONTROL_BRIDGE, (_, state: ControlBridgeVoiceState) => {
			sendState(state);
		});
	}

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
		connectedClientCount += 1;
		console.log(`[control-bridge] client connected (now ${connectedClientCount} connected)`);

		// A freshly-connected client (Launcher or a future overlay) shouldn't
		// have to wait for the next state change to see where things stand.
		if (lastKnownState) {
			socket.send(JSON.stringify({ type: 'state', atMs: Date.now(), voice: lastKnownState }));
		}

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
			handleCommand(socket, parsed);
		});

		socket.on('close', () => {
			connectedClientCount = Math.max(0, connectedClientCount - 1);
			console.log(`[control-bridge] client disconnected (now ${connectedClientCount} connected)`);
		});
		// No handler existed for this before -- an unhandled 'error' event on
		// an EventEmitter is fatal in Node (throws, can crash the whole
		// process) if nothing is listening for it. A single misbehaving
		// client socket taking down every other connected client's bridge
		// would be exactly the kind of silent, hard-to-diagnose failure this
		// logging pass exists to close.
		socket.on('error', (err: Error) =>
			console.error('[control-bridge] client socket error (connection kept, others unaffected):', err.message));
	});

	server.on('error', (err: Error) => console.error('[control-bridge] server error:', err.message));
}

export function stopControlBridge(): void {
	server?.close();
	server = null;
	lastKnownState = null;
}
