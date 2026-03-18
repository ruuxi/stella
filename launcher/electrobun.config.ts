import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Stella",
		identifier: "com.stella.app",
		version: "0.0.1",
	},
	build: {
		// Vite builds to dist/, we copy from there
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"assets/tray-icon.ico": "views/assets/tray-icon.ico",
			"assets/tray-icon.png": "views/assets/tray-icon.png",
			"assets/stella-logo.svg": "views/assets/stella-logo.svg",
		},
		// Ignore Vite output in watch mode — HMR handles view rebuilds separately
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
			icon: "assets/tray-icon.ico",
		},
	},
} satisfies ElectrobunConfig;
