'use strict'; // eslint-disable-line

import { autoUpdater } from 'electron-updater';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import windowStateKeeper from 'electron-window-state';
import { platform } from 'os';
import { join as joinPath } from 'path';
import { format as formatUrl } from 'url';
import './hook';
import { overlayWindow } from 'electron-overlay-window';
import { initializeIpcHandlers, initializeIpcListeners } from './ipc-handlers';
import { IpcHandlerMessages } from '../common/ipc-messages';
import { protocol } from 'electron';
import Store from 'electron-store';
import { ISettings } from '../common/ISettings';
import installExtension, { REACT_DEVELOPER_TOOLS } from 'electron-devtools-installer';
import { gameReader } from './hook';
import { GenerateHat } from './avatarGenerator';
import { startControlBridge } from './controlBridge';
import log from 'electron-log';

// Simon's Among Us: this app is show:false by design (see createMainWindow
// below), so console.log/console.error calls throughout this process --
// including controlBridge.ts's own bridge lifecycle logging -- previously
// went nowhere a human could ever read. Confirmed live, 2026-08-17: a real
// tester's voice bridge got stuck unreachable for minutes with zero
// evidence of what this process was actually doing during that time,
// because there was no log file at all. electron-log was already an
// installed dependency (used nowhere) -- Object.assign(console, log.functions)
// is its own documented pattern for making every EXISTING console.* call
// in this codebase also write to a real file, with no need to touch each
// call site individually. Default location on Windows:
// %USERPROFILE%\AppData\Roaming\BetterCrewLink\logs\main.log -- automatic
// rotation/archiving is electron-log's own default behavior, not configured
// here.
log.transports.file.level = 'info';
log.transports.console.level = 'info';
Object.assign(console, log.functions);
console.log(`Logging to file: ${log.transports.file.getFile().path}`);

// No global error handler existed anywhere in this process before this --
// an uncaught exception or unhandled Promise rejection in the main process
// (this hidden, show:false app has no visible console to notice one in)
// could otherwise fail silently, with no evidence it ever happened. Log and
// keep running rather than exit: this app already fails open by design
// elsewhere (see controlBridge.ts's own doc comment), and a main-process
// exit would take the live voice connection down for everyone in the mesh,
// a worse outcome than a degraded feature staying degraded.
process.on('uncaughtException', (error) => {
	console.error('[main] uncaught exception (process kept running):', error);
});
process.on('unhandledRejection', (reason) => {
	console.error('[main] unhandled promise rejection (process kept running):', reason);
});

const args = require('minimist')(process.argv); // eslint-disable-line
const isDevelopment = process.env.NODE_ENV !== 'production';
const devTools = (isDevelopment || args.dev === 1) && true;
const appVersion: string = isDevelopment? "DEV" : autoUpdater.currentVersion.version;

declare global {
	namespace NodeJS {
		// eslint-disable-line
		interface Global {
			mainWindow: BrowserWindow | null;
			overlay: BrowserWindow | null;
			lobbyBrowser: BrowserWindow | null;
		}
	}
}
// global reference to mainWindow (necessary to prevent window from being garbage collected)
global.mainWindow = null;
global.overlay = null;
const store = new Store<ISettings>();
app.commandLine.appendSwitch('disable-pinch');

if (platform() === 'linux' || !store.get('hardware_acceleration', true)) {
	app.disableHardwareAcceleration();

}

if(platform() === 'linux'){
	app.commandLine.appendSwitch('disable-gpu-sandbox');
}

function createMainWindow() {
	const mainWindowState = windowStateKeeper({});

	const window = new BrowserWindow({
		title: 'BetterCrewLink',
		width: 250,
		height: 350,
		maxWidth: 250,
		minWidth: 250,
		maxHeight: 350,
		minHeight: 350,
		x: mainWindowState.x,
		y: mainWindowState.y,
		resizable: false,
		frame: false,
		fullscreenable: false,
		maximizable: false,
		// Simon's Among Us Stage 1 experiment: never show the main control
		// window. Electron's show:false is already used in this codebase for
		// the overlay window (see createOverlay() below) -- this is the first
		// time it's applied to the main window.
		show: false,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false
		},
	});
	mainWindowState.manage(window);

	if (devTools) {
		//Force devtools into detached mode otherwise they are unusable
		window.on('ready-to-show', () => {
			window.webContents.openDevTools({
				mode: 'detach',
			});
		})
	}

	if (isDevelopment) {
		window.loadURL(`http://localhost:${process.env.ELECTRON_WEBPACK_WDS_PORT}?version=DEV&view=app`);
	} else {
		window.loadURL(
			formatUrl({
				pathname: joinPath(__dirname, 'index.html'),
				protocol: 'file',
				query: {
					version: appVersion,
					view: 'app',
				},
				slashes: true,
			})
		);
	}
	//window.webContents.userAgent = `CrewLink/${crewlinkVersion} (${process.platform})`;
	window.webContents.userAgent = `BetterCrewLink/${appVersion} (win32)`;

	window.on('closed', () => {
		try {
			const mainWindow = global.mainWindow;
			const overlay = global.overlay;
			global.mainWindow = null;
			global.overlay = null;
			overlay?.close();
			mainWindow?.destroy();
			overlay?.destroy();
		} catch {
			/* empty */
		}
	});

	window.webContents.on('devtools-opened', () => {
		window.focus();
		setImmediate(() => {
			window.focus();
		});
	});
	console.log('Opened app version: ', appVersion);
	return window;
}

function createLobbyBrowser() {
	const window = new BrowserWindow({
		title: 'BetterCrewLink Browser',
		width: 900,
		height: 500,
		minWidth: 250,
		minHeight: 350,
		resizable: true,
		frame: false,
		fullscreenable: false,
		closable: true,
		maximizable: false,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
		},
	});

	window.on('closed', () => {
		global.lobbyBrowser = null;
	});
	// if (devTools) {
	// 	// Force devtools into detached mode otherwise they are unusable
	// 	window.webContents.openDevTools({
	// 		mode: 'detach',
	// 	});
	// }
	if (isDevelopment) {
		window.loadURL(`http://localhost:${process.env.ELECTRON_WEBPACK_WDS_PORT}?version=DEV&view=lobbies`);
	} else {
		window.loadURL(
			formatUrl({
				pathname: joinPath(__dirname, 'index.html'),
				protocol: 'file',
				query: {
					version: appVersion,
					view: 'lobbies',
				},
				slashes: true,
			})
		);
	}
	window.webContents.userAgent = `BetterCrewLink/${appVersion} (win32)`;
	console.log('Opened app version: ', appVersion);
	return window;
}

function createOverlay() {
	const overlay = new BrowserWindow({
		title: 'BetterCrewLink Overlay',
		width: 400,
		height: 300,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
		},
		fullscreenable: true,
		skipTaskbar: true,
		frame: false,
		show: false,
		transparent: true,
		resizable: true,
		focusable: false,

		//	...overlayWindow.WINDOW_OPTS,
	});

	if (devTools) {
		overlay.webContents.openDevTools({
			mode: 'detach',
		});
	}

	if (isDevelopment) {
		overlay.loadURL(
			`http://localhost:${process.env.ELECTRON_WEBPACK_WDS_PORT}?version=${appVersion}&view=overlay`
		);
	} else {
		overlay.loadURL(
			formatUrl({
				pathname: joinPath(__dirname, 'index.html'),
				protocol: 'file',
				query: {
					version: appVersion,
					view: 'overlay',
				},
				slashes: true,
			})
		);
	}
	overlay.setIgnoreMouseEvents(true);
	overlayWindow.attachTo(overlay, 'Among Us');
	overlay.setBackgroundColor('#00000000');
	return overlay;
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
	app.quit();
} else {
	// Simon's Among Us Stage 5: this fork's own auto-updater is disabled
	// entirely, deliberately. Updates go through the Simon's Among Us
	// Launcher's own install/update flow (the same one already used for
	// Core/ATR/BepInEx) rather than a background process that -- for the
	// unmodified upstream binary -- would silently install a new build
	// from OhMyGuus/BetterCrewLink's own release feed and revert this
	// patch (see BETTERCREWLINK_STAGE1_4_EXPERIMENT_FINDINGS.md Stage 4 in
	// the Simon's Among Us repository for the empirical finding this
	// answers). No checkForUpdates(), no update-available/download-
	// progress/update-downloaded wiring, no quitAndInstall() anywhere in
	// this fork.

	// quit application when all windows are closed
	app.on('window-all-closed', () => {
		// Simon's Among Us Stage 1 experiment: the main window is now
		// show:false and never explicitly closed in normal operation, so this
		// event should only genuinely mean "all windows closed" if the main
		// window itself is actually gone (destroyed), not just because some
		// other, ancillary window (e.g. the lobby browser) was closed while
		// the hidden main window -- and the live voice connection running in
		// its renderer -- is still alive. Unresolved question from the
        // architecture study this answers: yes, a still-open (even if
        // hidden) BrowserWindow keeps window-all-closed from firing at all
        // when other closable windows exist; this guard only matters for the
        // case where something closes the main window directly.
		if (global.mainWindow && !global.mainWindow.isDestroyed()) {
			return;
		}
		// on macOS it is common for applications to stay open until the user explicitly quits
		try {
			const mainWindow = global.mainWindow;
			const overlay = global.overlay;
			global.mainWindow = null;
			global.overlay = null;
			overlay?.close();
			mainWindow?.destroy();
			overlay?.destroy();
		} catch {
			/* empty */
		}
		app.quit();
	});

	app.on('activate', () => {
		console.log("ACTIVATE???")
		// on macOS it is common to re-create a window even after all windows have been closed
		if (global.mainWindow === null) {
			global.mainWindow = createMainWindow();
		}

		session.fromPartition('default').setPermissionRequestHandler((webContents, permission, callback) => {
			const allowedPermissions = ['audioCapture']; // Full list here: https://developer.chrome.com/extensions/declare_permissions#manifest
			console.log('permission requested ', permission);
			if (allowedPermissions.includes(permission)) {
				callback(true); // Approve permission request
			} else {
				console.error(
					`The application tried to request permission for '${permission}'. This permission was not whitelisted and has been blocked.`
				);

				callback(false); // Deny
			}
		});
	});

	// create main BrowserWindow when electron is ready
	app.whenReady().then(() => {
		protocol.registerFileProtocol('static', (request, callback) => {
			const pathname = app.getPath('userData') + '/static/' + request.url.replace('static:///', '');
			callback(pathname);
		});

		protocol.registerFileProtocol('generate', async (request, callback) => {
			const url = new URL(request.url.replace('generate:///', ''));
			const path = await GenerateHat(url, gameReader.playercolors, Number(url.searchParams.get('color')), '');
			callback(path);
		});

		initializeIpcListeners();
		initializeIpcHandlers();
		global.mainWindow = createMainWindow();
		startControlBridge();

		if (isDevelopment)
			installExtension(REACT_DEVELOPER_TOOLS)
				.then((name: string) => console.log(`Added Extension:  ${name}`))
				.catch((err: string) => console.log('An error occurred: ', err));
	});

	app.on('second-instance', () => {
		// Someone tried to run a second instance, we should focus our window.
		if (global.mainWindow) {
			if (global.mainWindow.isMinimized()) global.mainWindow.restore();
			global.mainWindow.focus();
		}
	});

	ipcMain.on('update-app', () => {
		// Auto-update is disabled in this fork -- see the comment above
		// gotTheLock. Intentionally a no-op, not removed outright, so a
		// renderer still wired to send this message does nothing rather
		// than throwing.
	});

	ipcMain.on(IpcHandlerMessages.OPEN_LOBBYBROWSER, () => {
		if (!global.lobbyBrowser) {
			global.lobbyBrowser = createLobbyBrowser();
		} else {
			global.lobbyBrowser.show();
			global.lobbyBrowser.moveTop();
		}
	});

	ipcMain.on('enableOverlay', async (_event, enable) => {
		setTimeout(
			() => {

				try {
					if (enable) {
						if (!global.overlay) {
							global.overlay = createOverlay();
						}
						overlayWindow.show();
					} else {
						overlayWindow.hide();
						if (global.overlay?.closable) {
							overlayWindow.stop();
							global.overlay?.close();
							global.overlay = null;
						}
					}
				} catch (exception) {
					global.overlay?.hide();
					global.overlay?.close();
				}
			},
			1000
		)
	});

	ipcMain.on('setAlwaysOnTop', async (_event, enable) => {
		console.log("SETALWAYSONTOP?")
		if (global.mainWindow) {
			console.log("SETALWAYSONTOP?1")
			global.mainWindow.setAlwaysOnTop(enable, 'screen-saver');
		}
	});


}
