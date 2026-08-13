// Shared wire contract for Simon's Among Us's local control bridge (see
// src/main/controlBridge.ts). Deliberately narrow and primitive-typed, per
// the Stage 0 GPLv3 boundary analysis: this is the one shape crossing the
// process boundary, never BetterCrewLink's internal Redux/settings objects.
// A second simultaneous client (e.g. a future in-game overlay) can connect
// and receive the same broadcasts without any protocol change.

export interface ControlBridgeDevice {
	id: string;
	label: string;
}

export interface ControlBridgeVoiceState {
	muted: boolean;
	deafened: boolean;
	microphone: string;
	speaker: string;
	microphones: ControlBridgeDevice[];
	speakers: ControlBridgeDevice[];
}
