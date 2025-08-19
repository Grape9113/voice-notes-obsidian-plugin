import { App, Notice, Plugin, PluginManifest, PluginSettingTab, Setting } from "obsidian";

interface VoiceNotesSettings {
	apiKey: string;
	whisperModel: string;
	summaryModel: string;
	noteModel: string;
}

const DEFAULT_SETTINGS: VoiceNotesSettings = {
	apiKey: "",
	whisperModel: "whisper-1",
	summaryModel: "gpt-5-nano",
	noteModel: "gpt-5"
};

export default class VoiceNotesPlugin extends Plugin {
	settings: VoiceNotesSettings;

	private mediaStream: MediaStream | null = null;
	private mediaRecorder: MediaRecorder | null = null;
	private mediaChunks: BlobPart[] = [];
	private isRecording: boolean = false;

	private ribbonEl: HTMLElement | null = null;

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
	}

	async onload() {
		console.log("Voice Notes plugin loaded");

		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		this.addSettingTab(new VoiceNotesSettingTab(this.app, this));

		this.ribbonEl = this.addRibbonIcon(
			"mic",
			"Voice Notes: Start/Stop Recording",
			async () => {
				try {
					if (this.isRecording) {
						await this.stopRecording();
					} else {
						await this.startRecording();
					}
				} catch (error) {
					console.error(error);
					new Notice("Voice Notes: Error. See console for details.");
				}
			}
		);

		this.addCommand({
			id: "voice-notes-toggle-recording",
			name: "Voice Notes: Toggle Recording",
			callback: async () => {
				if (this.isRecording) {
					await this.stopRecording();
				} else {
					await this.startRecording();
				}
			}
		});
	}

	onunload() {
		console.log("Voice Notes plugin unloaded");
		if (this.isRecording) {
			this.mediaRecorder?.stop();
		}
		this.mediaStream?.getTracks().forEach((t) => t.stop());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private setRecordingUIState(recording: boolean) {
		this.isRecording = recording;
		if (this.ribbonEl) {
			this.ribbonEl.toggleClass("is-recording", recording);
			this.ribbonEl.setAttr("aria-pressed", recording ? "true" : "false");
			this.ribbonEl.setAttr("aria-label", recording ? "Voice Notes: Stop Recording" : "Voice Notes: Start Recording");
		}
	}

	private async startRecording() {
		if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
			new Notice("Voice Notes: Microphone is not available in this environment.");
			return;
		}

		try {
			this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (e) {
			console.error(e);
			new Notice("Voice Notes: Microphone permission denied.");
			return;
		}

		this.mediaChunks = [];

		const mimeTypeCandidates = [
			"audio/webm;codecs=opus",
			"audio/webm",
			"audio/ogg;codecs=opus",
			"audio/ogg"
		];
		let chosenMime: string | undefined = undefined;
		for (const candidate of mimeTypeCandidates) {
			if ((window as any).MediaRecorder && MediaRecorder.isTypeSupported(candidate)) {
				chosenMime = candidate;
				break;
			}
		}

		try {
			this.mediaRecorder = new MediaRecorder(this.mediaStream, chosenMime ? { mimeType: chosenMime } : undefined);
		} catch (e) {
			console.error("Failed to initialize MediaRecorder", e);
			new Notice("Voice Notes: Could not start recording.");
			return;
		}

		this.mediaRecorder.ondataavailable = (ev: BlobEvent) => {
			if (ev.data && ev.data.size > 0) {
				this.mediaChunks.push(ev.data);
			}
		};

		this.mediaRecorder.onstop = async () => {
			const audioBlob = new Blob(this.mediaChunks, { type: chosenMime ?? "audio/webm" });
			await this.processAudioNote(audioBlob);
			this.mediaStream?.getTracks().forEach((t) => t.stop());
			this.mediaStream = null;
			this.mediaRecorder = null;
			this.mediaChunks = [];
			this.setRecordingUIState(false);
		};

		this.mediaRecorder.start();
		this.setRecordingUIState(true);
		new Notice("Voice Notes: Recording started. Click again to stop.");
	}

	private async stopRecording() {
		if (this.mediaRecorder && this.isRecording) {
			this.mediaRecorder.stop();
			new Notice("Voice Notes: Recording stopped. Processing...");
		}
	}

	private async processAudioNote(audioBlob: Blob) {
		if (!this.settings.apiKey) {
			new Notice("Voice Notes: Set your OpenAI API key in settings.");
			return;
		}

		try {
			new Notice("Voice Notes: Transcribing...");
			const transcript = await this.transcribeWithWhisper(audioBlob);
			if (!transcript || !transcript.trim()) {
				new Notice("Voice Notes: Empty transcription.");
				return;
			}

			new Notice("Voice Notes: Summarizing...");
			const summary = await this.summarizeText(transcript);
			new Notice("Voice Notes: Creating note...");
			const noteContent = await this.createNoteFromSummary(summary);

			await this.saveMarkdownNote(noteContent);
			new Notice("Voice Notes: Note saved to vault.");
		} catch (error) {
			console.error("Voice Notes processing error", error);
			new Notice("Voice Notes: Failed to process audio. See console.");
		}
	}

	private async transcribeWithWhisper(audioBlob: Blob): Promise<string> {
		const formData = new FormData();
		const extension = this.detectAudioExtension(audioBlob.type);
		try {
			const file = new File([audioBlob], `voice-note.${extension}`, { type: audioBlob.type || "application/octet-stream" });
			formData.append("file", file);
		} catch (_) {
			formData.append("file", audioBlob, `voice-note.${extension}`);
		}
		formData.append("model", this.settings.whisperModel || "whisper-1");
		formData.append("response_format", "text");

		const response = await this.fetchWithRetry("https://api.openai.com/v1/audio/transcriptions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.settings.apiKey}`
			},
			body: formData
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`Whisper API error: ${response.status} ${response.statusText} ${errText}`);
		}

		const text = await response.text();
		return text;
	}

	private detectAudioExtension(mimeType: string | undefined): string {
		if (!mimeType) return "webm";
		if (mimeType.includes("webm")) return "webm";
		if (mimeType.includes("ogg")) return "ogg";
		if (mimeType.includes("wav")) return "wav";
		if (mimeType.includes("mp3")) return "mp3";
		return "webm";
	}

	private async summarizeText(transcript: string): Promise<string> {
		const messages = [
			{ role: "system", content: "Please summarize the following text into clear, concise bullet points.\nFormat the output as Markdown, with headers, subheaders, and bullet points where appropriate.\nAlways keep the output in the same language as the input." },
			{ role: "user", content: transcript }
		];

		const response = await this.fetchWithRetry("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.settings.apiKey}`
			},
			body: JSON.stringify({
				model: this.settings.summaryModel || "gpt-5-nano",
				messages,
				temperature: 0.2
			})
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`Summarization API error: ${response.status} ${response.statusText} ${errText}`);
		}

		const data = await response.json();
		const content = data.choices?.[0]?.message?.content ?? "";
		return content;
	}

	private async createNoteFromSummary(summaryMarkdown: string): Promise<string> {
		const messages = [
			{ role: "system", content: "You are managing a personal knowledge vault.\nBased on the following summarized note, decide what this content represents:\n- If it contains tasks, represent them as Markdown checkboxes (- [ ]).\n- If it describes a project, group it under a project heading with clear steps.\n- If it is archival or reference information, structure it as a Markdown note with headers and subheaders.\n- If it is unordered or rambling, reorganize it into a logical, structured note.\n\nAlways decide whether this content should:\n1. Become a new note,\n2. Be added to an existing note,\n3. Or replace an existing note.\n\nSuggest appropriate tags and create Obsidian-style [[links]] to related concepts.\nAlways return the output in the same language as the input.\nReturn final content as clean Markdown, ready to be written to the vault." },
			{ role: "user", content: summaryMarkdown }
		];

		const response = await this.fetchWithRetry("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.settings.apiKey}`
			},
			body: JSON.stringify({
				model: this.settings.noteModel || "gpt-5",
				messages,
				temperature: 0.3
			})
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`Note creation API error: ${response.status} ${response.statusText} ${errText}`);
		}

		const data = await response.json();
		const content = data.choices?.[0]?.message?.content ?? "";
		return content;
	}

	private async fetchWithRetry(input: RequestInfo, init: RequestInit, retries: number = 2, backoffMs: number = 800): Promise<Response> {
		let attempt = 0;
		while (true) {
			try {
				const res = await fetch(input, init);
				return res;
			} catch (err) {
				if (attempt >= retries) throw err;
				await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt)));
				attempt++;
			}
		}
	}

	private async saveMarkdownNote(content: string) {
		const filename = this.generateNoteFilename();
		const existing = this.app.vault.getAbstractFileByPath(filename);
		if (!existing) {
			await this.app.vault.create(filename, content);
			return;
		}

		let counter = 1;
		while (true) {
			const alternate = filename.replace(/\.md$/, ` (${counter}).md`);
			if (!this.app.vault.getAbstractFileByPath(alternate)) {
				await this.app.vault.create(alternate, content);
				return;
			}
			counter++;
		}
	}

	private generateNoteFilename(): string {
		const now = new Date();
		const yyyy = now.getFullYear();
		const mm = String(now.getMonth() + 1).padStart(2, "0");
		const dd = String(now.getDate()).padStart(2, "0");
		const hh = String(now.getHours()).padStart(2, "0");
		const min = String(now.getMinutes()).padStart(2, "0");
		return `Voice Note ${yyyy}-${mm}-${dd}-${hh}${min}.md`;
	}
}

class VoiceNotesSettingTab extends PluginSettingTab {
	plugin: VoiceNotesPlugin;

	constructor(app: App, plugin: VoiceNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Voice Notes Settings" });

		new Setting(containerEl)
			.setName("OpenAI API Key")
			.setDesc("Stored locally. Used for Whisper and GPT-5 calls.")
			.addText((text) =>
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Whisper model")
			.setDesc("Model for transcription.")
			.addDropdown((drop) =>
				drop
					.addOption("whisper-1", "whisper-1")
					.setValue(this.plugin.settings.whisperModel)
					.onChange(async (value) => {
						this.plugin.settings.whisperModel = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Summary model")
			.setDesc("Model for summarization.")
			.addDropdown((drop) =>
				drop
					.addOption("gpt-5-nano", "gpt-5-nano")
					.setValue(this.plugin.settings.summaryModel)
					.onChange(async (value) => {
						this.plugin.settings.summaryModel = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Note creation model")
			.setDesc("Model for structuring and creating notes.")
			.addDropdown((drop) =>
				drop
					.addOption("gpt-5", "gpt-5")
					.setValue(this.plugin.settings.noteModel)
					.onChange(async (value) => {
						this.plugin.settings.noteModel = value;
						await this.plugin.saveSettings();
					})
			);
	}
}