const SDK_VERSION = 1;
const HEARTBEAT_MS = 15000;
const SAVE_MS = 30000;
const SNAPSHOT_MS = 2000;

const state = {
	context: null,
	miniant: null,
	loadedSave: null,
	standalone: false,
	spectator: false,
	terminated: false,
	paused: false,
	resultReported: false,
	startedAt: Date.now(),
	score: 0,
	checkpoint: "boot",
	chapter: 1,
	level: 1,
	completedLevels: 0,
	constructStorageKey: "",
	constructProgress: null,
	heartbeatTimer: 0,
	saveTimer: 0,
	snapshotTimer: 0,
	lastSnapshotHash: "",
	lastProgressKey: "",
	resultPromise: Promise.resolve(),
};

function isStandaloneWindow() {
	try {
		return window.parent === window;
	} catch (_err) {
		return false;
	}
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMiniAnt() {
	if (window.MiniAnt) return window.MiniAnt;
	for (let elapsed = 0; elapsed < 3000; elapsed += 50) {
		await wait(50);
		if (window.MiniAnt) return window.MiniAnt;
	}
	return null;
}

function createLocalContext() {
	return {
		mode: { id: "solo", playerCount: 1, players: [1, 1] },
		player: { id: "local-player", seat: 0, displayName: "Player", countryFlag: null },
		participants: [
			{ id: "local-player", seat: 0, displayName: "Player", countryFlag: null },
		],
		settings: { sound: true, vibration: true },
		ui: { safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } },
		spectator: false,
		room: null,
	};
}

function applyContext(context) {
	state.context = context;
	state.spectator = context.spectator === true;
	document.documentElement.dataset.mode = context.mode?.id || "solo";
	document.documentElement.dataset.spectator = String(state.spectator);
	applySafeArea(context.ui?.safeAreaInsets);
	applySettings(context.settings);
	renderParticipantStrip(context);
}

function applyLoadedSave(save) {
	if (!save || typeof save !== "object") return;
	state.loadedSave = save;
	state.score = Number(save.score || 0);
	state.checkpoint = String(save.checkpoint || "boot");
	state.chapter = Math.max(1, Number(save.chapter || 1));
	state.level = Math.max(1, Number(save.level || 1));
	state.completedLevels = Math.max(0, Number(save.completedLevels || state.score || 0));
	if (save.constructStorageKey) state.constructStorageKey = String(save.constructStorageKey);
	if (save.constructProgress && typeof save.constructProgress === "object") state.constructProgress = save.constructProgress;
}

function applySafeArea(insets = {}) {
	const root = document.documentElement;
	root.style.setProperty("--safe-top", `${Number(insets.top || 0)}px`);
	root.style.setProperty("--safe-right", `${Number(insets.right || 0)}px`);
	root.style.setProperty("--safe-bottom", `${Number(insets.bottom || 0)}px`);
	root.style.setProperty("--safe-left", `${Number(insets.left || 0)}px`);
}

function applySettings(settings = {}) {
	document.documentElement.dataset.sound = settings.sound === false ? "off" : "on";
	document.documentElement.dataset.vibration = settings.vibration === false ? "off" : "on";
}

function renderParticipantStrip(context) {
	const participants = Array.isArray(context.participants) ? context.participants : [];
	let strip = document.getElementById("miniant-participants");
	if (participants.length <= 1 && !state.spectator) {
		strip?.remove();
		return;
	}
	if (!strip) {
		strip = document.createElement("div");
		strip.id = "miniant-participants";
		document.body.appendChild(strip);
	}
	strip.replaceChildren(
		...participants.map((participant) => {
			const item = document.createElement("span");
			const flag = countryFlagToEmoji(participant.countryFlag);
			item.textContent = `${flag ? `${flag} ` : ""}${participant.displayName || "Player"}`;
			return item;
		})
	);
}

function countryFlagToEmoji(code) {
	if (!/^[A-Z]{2}$/.test(code || "")) return "";
	return String.fromCodePoint(...[...code].map((char) => 0x1f1e6 + char.charCodeAt(0) - 65));
}

function quietEmbeddedError() {
	const message = document.createElement("div");
	message.id = "miniant-embed-error";
	message.textContent = "Loading";
	document.body.appendChild(message);
}

function stopConstructInput() {
	document.documentElement.dataset.inputDisabled = "true";
	for (const element of document.querySelectorAll("canvas, .c3htmlwrap")) {
		element.style.pointerEvents = "none";
	}
}

function resumeConstructInput() {
	if (state.spectator || state.terminated) return;
	document.documentElement.dataset.inputDisabled = "false";
	for (const element of document.querySelectorAll("canvas, .c3htmlwrap")) {
		element.style.pointerEvents = "";
	}
}

function pauseGame() {
	state.paused = true;
	stopConstructInput();
}

function resumeGame() {
	state.paused = false;
	resumeConstructInput();
}

function terminateGame() {
	state.terminated = true;
	window.clearInterval(state.heartbeatTimer);
	window.clearInterval(state.saveTimer);
	window.clearInterval(state.snapshotTimer);
	stopConstructInput();
}

function getCanvasSnapshot() {
	const canvas = window.c3canvas || document.querySelector("canvas");
	if (!canvas) return null;
	return { width: canvas.width || 0, height: canvas.height || 0 };
}

function createSnapshot() {
	return {
		v: 1,
		mode: state.context?.mode?.id || "solo",
		checkpoint: state.checkpoint,
		score: state.score,
		chapter: state.chapter,
		level: state.level,
		completedLevels: state.completedLevels,
		elapsedMs: Date.now() - state.startedAt,
		constructStorageKey: state.constructStorageKey,
		constructProgress: state.constructProgress,
		canvas: getCanvasSnapshot(),
	};
}

function snapshotMeta() {
	return {
		label: `Level ${state.completedLevels + 1}`,
		progressPct: Math.max(0, Math.min(100, Math.round((state.completedLevels / 3000) * 100))),
	};
}

async function publishSnapshot(force = false) {
	if (state.terminated || state.spectator || !state.miniant?.spectate?.publishState) return;
	const snapshot = createSnapshot();
	const hash = JSON.stringify(snapshot);
	if (!force && hash === state.lastSnapshotHash) return;
	if (hash.length > 16 * 1024) return;
	state.lastSnapshotHash = hash;
	await state.miniant.spectate.publishState(snapshot).catch(() => {});
}

function renderFromSnapshot(snapshot) {
	let overlay = document.getElementById("miniant-spectator-view");
	if (!overlay) {
		overlay = document.createElement("div");
		overlay.id = "miniant-spectator-view";
		document.body.appendChild(overlay);
	}
	const elapsed = Math.floor(Number(snapshot?.elapsedMs || 0) / 1000);
	overlay.textContent = `Watching WordFarm - ${snapshot?.checkpoint || "playing"} - ${elapsed}s`;
}

async function saveProgress(force = false) {
	if (state.terminated || state.spectator || !state.miniant?.state?.save) return;
	if (!force && state.paused) return;
	const snapshot = createSnapshot();
	if (JSON.stringify(snapshot).length > 64 * 1024) return;
	await state.miniant.state.save(snapshot, snapshotMeta()).catch(() => {});
}

async function reportProgress() {
	if (state.terminated || state.paused || state.spectator || !state.miniant?.reportProgress) return;
	await state.miniant.reportProgress({
		checkpoint: state.checkpoint,
		score: state.score,
		tick: Date.now() - state.startedAt,
	}).catch(() => {});
}

function maybeJsonParse(value) {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch (_err) {
		return value;
	}
}

function findNumericKey(value, key) {
	if (!value || typeof value !== "object") return null;
	if (Object.prototype.hasOwnProperty.call(value, key)) {
		const numeric = Number(value[key]);
		return Number.isFinite(numeric) ? numeric : null;
	}
	for (const child of Object.values(value)) {
		const result = findNumericKey(child, key);
		if (result !== null) return result;
	}
	return null;
}

function trackConstructStorageValue(key, value) {
	if (!key || value == null) return;
	const parsed = maybeJsonParse(value);
	const chapterUnlock = findNumericKey(parsed, "chapter_unlock");
	const levelUnlock = findNumericKey(parsed, "level_unlock");
	const coins = findNumericKey(parsed, "coin");
	if (chapterUnlock === null && levelUnlock === null && coins === null) return;

	const chapter = Math.max(1, Math.floor(chapterUnlock ?? state.chapter));
	const levelUnlockIndex = Math.max(0, Math.floor(levelUnlock ?? Math.max(0, state.level - 1)));
	const completedLevels = Math.max(0, (chapter - 1) * 30 + levelUnlockIndex);
	state.constructStorageKey = String(key);
	state.constructProgress = {
		chapter_unlock: chapter,
		level_unlock: levelUnlockIndex,
		coin: Math.max(0, Math.floor(coins ?? 0)),
	};
	state.chapter = chapter;
	state.level = levelUnlockIndex + 1;
	state.completedLevels = completedLevels;
	state.score = completedLevels;
	state.checkpoint = `chapter_${state.chapter}_level_${state.level}`;

	const progressKey = `${state.checkpoint}:${state.score}`;
	if (progressKey !== state.lastProgressKey) {
		state.lastProgressKey = progressKey;
		void reportProgress();
		void saveProgress(true);
		void publishSnapshot(true);
	}
	if (state.completedLevels >= 3000) {
		window.WordFarmMiniAnt?.completeGame?.(state.score);
	}
}

async function buildRestoredConstructValue(existingValue) {
	if (!state.constructProgress) return null;
	const base = maybeJsonParse(existingValue);
	let config = base && typeof base === "object" ? base : null;
	if (!config || !Object.prototype.hasOwnProperty.call(config, "chapters")) {
		try {
			config = await fetch("config.json").then((response) => response.json());
		} catch (_err) {
			config = {};
		}
	}
	return JSON.stringify({
		...config,
		level_unlock: state.constructProgress.level_unlock,
		chapter_unlock: state.constructProgress.chapter_unlock,
		coin: state.constructProgress.coin,
	});
}

function installConstructStorageBridge() {
	const tryPatch = () => {
		const acts = window.C3?.Plugins?.LocalStorage?.Acts;
		if (!acts || acts.__miniantPatched) return false;
		const originalSetItem = acts.SetItem;
		const originalGetItem = acts.GetItem;
		const originalCheckItemExists = acts.CheckItemExists;
		acts.SetItem = async function patchedMiniAntSetItem(key, value) {
			await originalSetItem.call(this, key, value);
			trackConstructStorageValue(key, value);
		};
		acts.GetItem = async function patchedMiniAntGetItem(key) {
			if (state.constructProgress && (!state.constructStorageKey || state.constructStorageKey === key)) {
				const existing = await this._storage.getItem(key).catch(() => null);
				const restored = await buildRestoredConstructValue(existing);
				if (restored) await this._storage.setItem(key, restored).catch(() => {});
			}
			await originalGetItem.call(this, key);
		};
		acts.CheckItemExists = async function patchedMiniAntCheckItemExists(key) {
			if (state.constructProgress && (!state.constructStorageKey || state.constructStorageKey === key)) {
				const existing = await this._storage.getItem(key).catch(() => null);
				const restored = await buildRestoredConstructValue(existing);
				if (restored) await this._storage.setItem(key, restored).catch(() => {});
			}
			await originalCheckItemExists.call(this, key);
		};
		Object.defineProperty(acts, "__miniantPatched", { value: true });
		return true;
	};
	if (tryPatch()) return;
	const timer = window.setInterval(() => {
		if (tryPatch()) window.clearInterval(timer);
	}, 25);
	window.setTimeout(() => window.clearInterval(timer), 10000);
}

async function reportResult(outcome = "abandoned", extra = {}) {
	if (state.resultReported || state.spectator || !state.miniant?.reportResult) return state.resultPromise;
	state.resultReported = true;
	const payload = {
		outcome,
		score: state.score,
		durationMs: Date.now() - state.startedAt,
		detail: {
			mode: state.context?.mode?.id || "solo",
			checkpoint: state.checkpoint,
			...extra,
		},
	};
	state.resultPromise = state.miniant.reportResult(payload).catch(() => {});
	return state.resultPromise;
}

function showGameOver(outcome = "completed") {
	if (document.getElementById("miniant-game-over")) return;
	const overlay = document.createElement("div");
	overlay.id = "miniant-game-over";
	const panel = document.createElement("div");
	const title = document.createElement("h1");
	title.textContent = "Game Over";
	const rematch = document.createElement("button");
	rematch.type = "button";
	rematch.textContent = "Rematch";
	const exit = document.createElement("button");
	exit.type = "button";
	exit.textContent = "Exit";
	rematch.addEventListener("click", async () => {
		await reportResult(outcome);
		await state.miniant?.requestRematch?.();
	});
	exit.addEventListener("click", async () => {
		await reportResult("abandoned", { exit: true });
		state.miniant?.exit?.();
	});
	panel.append(title, rematch, exit);
	overlay.append(panel);
	document.body.appendChild(overlay);
}

function exposeBridgeApi() {
	window.WordFarmMiniAnt = {
		context: () => state.context,
		setScore(score) {
			state.score = Number(score) || 0;
			void publishSnapshot(true);
		},
		setCheckpoint(checkpoint) {
			state.checkpoint = String(checkpoint || "playing");
			void reportProgress();
			void saveProgress(true);
			void publishSnapshot(true);
		},
		completeGame(score = state.score) {
			state.score = Number(score) || state.score;
			showGameOver("completed");
			void reportResult("completed");
		},
		reportResult,
		publishSnapshot,
		renderFromSnapshot,
	};
}

function wireMiniAntEvents() {
	state.miniant.on?.("pause", () => {
		pauseGame();
		void saveProgress(true);
	});
	state.miniant.on?.("resume", () => {
		resumeGame();
	});
	state.miniant.on?.("settings_changed", (settings) => {
		applySettings(settings || {});
	});
	state.miniant.on?.("terminate", ({ reason } = {}) => {
		if (reason !== "player_exit") void saveProgress(true);
		terminateGame();
	});
	state.miniant.state?.onSaveRequest?.(() => createSnapshot());
}

async function startConstructGame() {
	installConstructStorageBridge();
	await import("./main.js");
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	if (state.spectator) stopConstructInput();
	await state.miniant?.ready?.();
	void publishSnapshot(true);
}

async function boot() {
	exposeBridgeApi();
	const standalone = isStandaloneWindow();
	const miniant = standalone ? null : await waitForMiniAnt();
	state.standalone = standalone && !miniant;
	if (!miniant && !standalone) {
		quietEmbeddedError();
		return;
	}
	state.miniant = miniant;
	if (miniant) {
		const context = await miniant.init({ sdkVersion: SDK_VERSION });
		applyContext(context);
		if (context.spectator === true) {
			stopConstructInput();
			miniant.net?.on?.("message", ({ data }) => renderFromSnapshot(data));
			await miniant.net?.connect?.();
		} else {
			const loadedSave = await window.MiniAnt.state.load().catch(() => null);
			applyLoadedSave(loadedSave);
			wireMiniAntEvents();
		}
	} else {
		applyContext(createLocalContext());
	}
	await startConstructGame();
	if (!state.spectator) {
		state.heartbeatTimer = window.setInterval(reportProgress, HEARTBEAT_MS);
		state.saveTimer = window.setInterval(() => saveProgress(false), SAVE_MS);
	}
	state.snapshotTimer = window.setInterval(() => publishSnapshot(false), SNAPSHOT_MS);
	window.addEventListener("pagehide", () => {
		void reportResult("abandoned", { pagehide: true });
	});
}

void boot();
