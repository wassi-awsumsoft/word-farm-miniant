import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const allowedTopLevel = new Set([
	"box2d.wasm",
	"box2d.wasm.js",
	"chapters",
	"config.json",
	"data.json",
	"fonts",
	"icons",
	"images",
	"index.html",
	"media",
	"miniant.json",
	"scripts",
	"style.css",
]);
const excludedNames = new Set([
	"build.mjs",
	"register-sw.js",
	"sw.js",
	"appmanifest.json",
	"service-worker.js",
	"workbox.js",
]);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

function copyEntry(src, dest) {
	const stat = fs.statSync(src);
	if (stat.isDirectory()) {
		fs.mkdirSync(dest, { recursive: true });
		for (const child of fs.readdirSync(src)) {
			if (excludedNames.has(child)) continue;
			copyEntry(path.join(src, child), path.join(dest, child));
		}
		return;
	}
	if (excludedNames.has(path.basename(src))) return;
	fs.copyFileSync(src, dest);
}

for (const entry of fs.readdirSync(root)) {
	if (!allowedTopLevel.has(entry) || excludedNames.has(entry)) continue;
	copyEntry(path.join(root, entry), path.join(dist, entry));
}

console.log(`Built MiniAnt package at ${dist}`);
