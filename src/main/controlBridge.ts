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
// client (e.g. a future in-game overlay) can connect and receive the same
// state without any protocol change.
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
		console.log('[control-bridge] client connected');

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

		socket.on('close', () => console.log('[control-bridge] client disconnected'));
	});

	server.on('error', (err: Error) => console.log('[control-bridge] server error:', err.message));
}

export function stopControlBridge(): void {
	server?.close();
	server = null;
	lastKnownState = null;
}
