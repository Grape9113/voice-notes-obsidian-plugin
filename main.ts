import { App, Plugin, PluginManifest } from "obsidian";

export default class VoiceNotesPlugin extends Plugin {
	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
	}

	async onload() {
		console.log("Voice Notes plugin loaded");

		// Add a simple command to test the plugin
		this.addCommand({
			id: "voice-notes-test",
			name: "Test Voice Notes",
			callback: () => {
				new Notice("Voice Notes plugin is working!");
			}
		});
	}

	onunload() {
		console.log("Voice Notes plugin unloaded");
	}
}