import { App, Notice, Plugin, PluginManifest, PluginSettingTab, Setting } from "obsidian";

interface VoiceNotesSettings {
	apiKey: string;
	whisperModel: string;
	summaryModel: string;
	noteModel: string;
	transcriptionLanguages: string[];
}

// Supported languages for transcription models
const SUPPORTED_LANGUAGES = [
	{ code: "af", name: "Afrikaans" },
	{ code: "ar", name: "Arabic" },
	{ code: "az", name: "Azerbaijani" },
	{ code: "bg", name: "Bulgarian" },
	{ code: "bn", name: "Bengali" },
	{ code: "ca", name: "Catalan" },
	{ code: "cs", name: "Czech" },
	{ code: "da", name: "Danish" },
	{ code: "de", name: "German" },
	{ code: "el", name: "Greek" },
	{ code: "en", name: "English" },
	{ code: "es", name: "Spanish" },
	{ code: "et", name: "Estonian" },
	{ code: "eu", name: "Basque" },
	{ code: "fa", name: "Persian" },
	{ code: "fi", name: "Finnish" },
	{ code: "fr", name: "French" },
	{ code: "ga", name: "Irish" },
	{ code: "gl", name: "Galician" },
	{ code: "he", name: "Hebrew" },
	{ code: "hi", name: "Hindi" },
	{ code: "hr", name: "Croatian" },
	{ code: "hu", name: "Hungarian" },
	{ code: "hy", name: "Armenian" },
	{ code: "id", name: "Indonesian" },
	{ code: "is", name: "Icelandic" },
	{ code: "it", name: "Italian" },
	{ code: "ja", name: "Japanese" },
	{ code: "ka", name: "Georgian" },
	{ code: "kk", name: "Kazakh" },
	{ code: "ko", name: "Korean" },
	{ code: "lt", name: "Lithuanian" },
	{ code: "lv", name: "Latvian" },
	{ code: "mk", name: "Macedonian" },
	{ code: "mn", name: "Mongolian" },
	{ code: "ms", name: "Malay" },
	{ code: "mt", name: "Maltese" },
	{ code: "nl", name: "Dutch" },
	{ code: "no", name: "Norwegian" },
	{ code: "pl", name: "Polish" },
	{ code: "pt", name: "Portuguese" },
	{ code: "ro", name: "Romanian" },
	{ code: "ru", name: "Russian" },
	{ code: "sk", name: "Slovak" },
	{ code: "sl", name: "Slovenian" },
	{ code: "sq", name: "Albanian" },
	{ code: "sr", name: "Serbian" },
	{ code: "sv", name: "Swedish" },
	{ code: "sw", name: "Swahili" },
	{ code: "ta", name: "Tamil" },
	{ code: "th", name: "Thai" },
	{ code: "tr", name: "Turkish" },
	{ code: "uk", name: "Ukrainian" },
	{ code: "ur", name: "Urdu" },
	{ code: "uz", name: "Uzbek" },
	{ code: "vi", name: "Vietnamese" },
	{ code: "zh", name: "Chinese" }
];

const DEFAULT_SETTINGS: VoiceNotesSettings = {
	apiKey: "",
	whisperModel: "gpt-4o-transcribe",
	summaryModel: "gpt-5-nano",
	noteModel: "gpt-5",
	transcriptionLanguages: ["en"]
};

export default class VoiceNotesPlugin extends Plugin {
	settings: VoiceNotesSettings;

	private mediaStream: MediaStream | null = null;
	private mediaRecorder: MediaRecorder | null = null;
	private mediaChunks: BlobPart[] = [];
	private isRecording: boolean = false;

	private ribbonEl: HTMLElement | null = null;

    // No session secrets needed; HTTPS ensures encryption in transit

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
	}

	async onload() {
		console.log("Voice Notes plugin loaded");

		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		this.addSettingTab(new VoiceNotesSettingTab(this.app, this));

        // Nothing else needed here

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

		// Prepare ribbon status styling
		if (this.ribbonEl) {
			this.ribbonEl.addClass("voice-notes-ribbon");
			this.setStage("idle");
		}

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
		this.setStage("recording");
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
			this.setStage("transcribing");
			new Notice("Voice Notes: Transcribing...");
			const transcript = await this.transcribeWithWhisper(audioBlob);
			if (!transcript || !transcript.trim()) {
				new Notice("Voice Notes: Empty transcription.");
				this.setStage("error");
				this.deferIdle();
				return;
			}

			this.setStage("summarizing");
			new Notice("Voice Notes: Summarizing...");
			const summary = await this.summarizeText(transcript);
			this.setStage("creating");
			new Notice("Voice Notes: Creating note...");
			const noteContent = await this.createNoteFromSummary(summary);

			await this.saveMarkdownNote(noteContent);
			new Notice("Voice Notes: Note saved to vault.");
			this.setStage("success");
			this.deferIdle();
		} catch (error) {
			console.error("Voice Notes processing error:", error);
			
			// Provide more specific error messages
			let errorMessage = "Voice Notes: Failed to process audio.";
			if (error instanceof Error) {
				if (error.message.includes("Whisper API error")) {
					errorMessage = "Voice Notes: Transcription failed. Check your API key and internet connection.";
				} else if (error.message.includes("Summarization API error")) {
					errorMessage = "Voice Notes: Summarization failed. Check your API key and internet connection.";
				} else if (error.message.includes("Note creation API error")) {
					errorMessage = "Voice Notes: Note creation failed. Check your API key and internet connection.";
				} else if (error.message.includes("Failed to fetch")) {
					errorMessage = "Voice Notes: Network error. Check your internet connection.";
				}
			}
			
			new Notice(errorMessage);
			this.setStage("error");
			this.deferIdle();
		}
	}

	private async transcribeWithWhisper(audioBlob: Blob): Promise<string> {
		console.log("Starting transcription with model:", this.settings.whisperModel);
		
		// If only one language is selected, force that language
		if (this.settings.transcriptionLanguages.length === 1) {
			return await this.transcribeWithLanguage(audioBlob, this.settings.transcriptionLanguages[0]);
		}
		
		// Try auto-detection first
		try {
			const autoResult = await this.transcribeWithLanguage(audioBlob, "auto");
			console.log("Auto-detection successful, length:", autoResult.length);
			return autoResult;
		} catch (error) {
			console.log("Auto-detection failed, trying individual languages");
		}
		
		// If auto-detection fails or detected language not in list, try each selected language
		for (const language of this.settings.transcriptionLanguages) {
			try {
				new Notice(`Voice Notes: Retrying with ${language.toUpperCase()}...`);
				const result = await this.transcribeWithLanguage(audioBlob, language);
				if (result && result.trim()) {
					console.log(`Transcription successful with ${language}, length:`, result.length);
					return result;
				}
			} catch (error) {
				console.log(`Transcription failed with ${language}:`, error);
				continue;
			}
		}
		
		throw new Error("All transcription attempts failed");
	}
	
	private async transcribeWithLanguage(audioBlob: Blob, language: string): Promise<string> {
		const formData = new FormData();
		const extension = this.detectAudioExtension(audioBlob.type);
		try {
			const file = new File([audioBlob], `voice-note.${extension}`, { type: audioBlob.type || "application/octet-stream" });
			formData.append("file", file);
		} catch (_) {
			formData.append("file", audioBlob, `voice-note.${extension}`);
		}
		formData.append("model", this.settings.whisperModel || "gpt-4o-transcribe");
		formData.append("response_format", "text");
		
		// Only add language parameter if not auto-detection
		if (language !== "auto") {
			formData.append("language", language);
		}

		const response = await this.fetchWithRetry("https://api.openai.com/v1/audio/transcriptions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.settings.apiKey}`
			},
			body: formData
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			console.error("Whisper API response error:", response.status, response.statusText, errText);
			throw new Error(`Whisper API error: ${response.status} ${response.statusText} - ${errText}`);
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

	private setStage(stage: "idle" | "recording" | "transcribing" | "summarizing" | "creating" | "success" | "error") {
		if (!this.ribbonEl) return;
		const stages = ["idle", "recording", "transcribing", "summarizing", "creating", "success", "error"] as const;
		for (const s of stages) this.ribbonEl.removeClass(`vn-${s}`);
		this.ribbonEl.addClass(`vn-${stage}`);
		const labelByStage: Record<string, string> = {
			idle: "Voice Notes: Start Recording",
			recording: "Voice Notes: Recording... Click to stop",
			transcribing: "Voice Notes: Transcribing...",
			summarizing: "Voice Notes: Summarizing...",
			creating: "Voice Notes: Creating note...",
			success: "Voice Notes: Done",
			error: "Voice Notes: Error",
		};
		this.ribbonEl.setAttr("aria-label", labelByStage[stage] || "Voice Notes");
	}

	private deferIdle(timeoutMs: number = 1500) {
		window.setTimeout(() => {
			if (!this.isRecording) this.setStage("idle");
		}, timeoutMs);
	}

	private async summarizeText(transcript: string): Promise<string> {
		console.log("Starting summarization with model:", this.settings.summaryModel);
		
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
				messages
			})
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			console.error("Summarization API response error:", response.status, response.statusText, errText);
			throw new Error(`Summarization API error: ${response.status} ${response.statusText} - ${errText}`);
		}

		const data = await response.json();
		const content = data.choices?.[0]?.message?.content ?? "";
		console.log("Summarization successful, length:", content.length);
		return content;
	}

	private async createNoteFromSummary(summaryMarkdown: string): Promise<string> {
		const startTime = Date.now();
		const summaryTokens = Math.ceil(summaryMarkdown.length / 4); // Rough token estimate
		console.log(`Starting note creation with model: ${this.settings.noteModel}, summary tokens: ~${summaryTokens}`);
		
		// Get compact vault context (5 candidate notes max)
		const compactContext = await this.getCompactVaultContext();
		const contextTokens = Math.ceil(compactContext.length / 4);
		console.log(`Context tokens: ~${contextTokens}, total input: ~${summaryTokens + contextTokens}`);
		
		// Model selection: use mini for short summaries, full for complex content
		const useMiniModel = summaryTokens < 400;
		const selectedModel = useMiniModel ? "gpt-5-mini" : (this.settings.noteModel || "gpt-5");
		console.log(`Selected model: ${selectedModel} (${useMiniModel ? 'mini for speed' : 'full for complexity'})`);
		
		const messages = [
			{ 
				role: "system", 
				content: "Return ONLY final Markdown in the same language. No explanations."
			},
			{ 
				role: "user", 
				content: `Summary: ${summaryMarkdown}

Rules: Tasks as - [ ] or - [x], projects with headers, reference info structured. No empty stub links. Decide: new note, append to existing, or replace existing.

Context: ${compactContext}`
			}
		];

		// Optimized API call with timeout and retry
		const response = await this.fetchWithTimeoutAndRetry("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.settings.apiKey}`
			},
			body: JSON.stringify({
				model: selectedModel,
				messages,
				max_tokens: 1200,
				temperature: 0.2,
				n: 1
			})
		}, 45000); // 45s timeout

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			console.error("Note creation API response error:", response.status, response.statusText, errText);
			throw new Error(`Note creation API error: ${response.status} ${response.statusText} - ${errText}`);
		}

		const data = await response.json();
		const content = data.choices?.[0]?.message?.content ?? "";
		const totalTime = Date.now() - startTime;
		console.log(`Note creation successful: ${content.length} chars, ${Math.ceil(content.length / 4)} tokens, ${totalTime}ms`);
		return content;
	}

	// LATENCY OPTIMIZATION: Enhanced fetch with timeout and exponential backoff retry
	private async fetchWithTimeoutAndRetry(input: RequestInfo, init: RequestInit, timeoutMs: number = 45000, retries: number = 1, backoffMs: number = 1000): Promise<Response> {
		let attempt = 0;
		while (true) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
				
				const response = await fetch(input, { ...init, signal: controller.signal });
				clearTimeout(timeoutId);
				return response;
			} catch (err) {
				if (attempt >= retries) throw err;
				console.log(`Attempt ${attempt + 1} failed, retrying in ${backoffMs}ms...`);
				await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, attempt)));
				attempt++;
			}
		}
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

    // No local encryption helpers needed

	private async saveMarkdownNote(content: string): Promise<void> {
		console.log("Saving markdown note, content length:", content.length);
		
		try {
			// Parse the AI response to determine action
			const aiResponse = JSON.parse(content);
			
			if (aiResponse.action === "update" && aiResponse.targetNote) {
				// Update existing note
				await this.updateExistingNote(aiResponse.targetNote, aiResponse.content);
				new Notice(`Voice Notes: Updated existing note: ${aiResponse.targetNote}`);
			} else if (aiResponse.action === "append" && aiResponse.targetNote) {
				// Append to existing note
				await this.appendToExistingNote(aiResponse.targetNote, aiResponse.content);
				new Notice(`Voice Notes: Appended to existing note: ${aiResponse.targetNote}`);
			} else {
				// Create new note
				const filename = this.generateNoteFilename();
				await this.app.vault.create(filename, aiResponse.content);
				new Notice(`Voice Notes: Created new note: ${filename}`);
			}
		} catch (error) {
			console.error("Error parsing AI response or saving note:", error);
			// Fallback to creating new note with original content
			const filename = this.generateNoteFilename();
			await this.app.vault.create(filename, content);
			new Notice(`Voice Notes: Created new note (fallback): ${filename}`);
		}
	}
	
	private async updateExistingNote(filename: string, newContent: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(filename);
		if (existing) {
			await this.app.vault.modify(existing, newContent);
		} else {
			// If target note doesn't exist, create it
			await this.app.vault.create(filename, newContent);
		}
	}
	
	private async appendToExistingNote(filename: string, contentToAppend: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(filename);
		if (existing) {
			const currentContent = await this.app.vault.read(existing);
			const updatedContent = currentContent + "\n\n" + contentToAppend;
			await this.app.vault.modify(existing, updatedContent);
		} else {
			// If target note doesn't exist, create it
			await this.app.vault.create(filename, contentToAppend);
		}
	}
	
	// LATENCY OPTIMIZATION: Compact context for note creation (5 notes max, 1-2 line summaries)
	private async getCompactVaultContext(): Promise<string> {
		try {
			const allFiles = this.app.vault.getMarkdownFiles();
			const recentFiles = allFiles
				.sort((a, b) => b.stat.mtime - a.stat.mtime)
				.slice(0, 5); // Reduced from 10 to 5 for speed
			
			let context = "Recent notes:\n";
			
			for (const file of recentFiles) {
				try {
					const content = await this.app.vault.read(file);
					const title = file.basename;
					// Extract only first line or first sentence for compact context
					const firstLine = content.split('\n')[0].substring(0, 100);
					context += `- ${title}: ${firstLine}...\n`;
				} catch (error) {
					console.log(`Could not read file ${file.path}:`, error);
				}
			}
			
			return context;
		} catch (error) {
			console.error("Error getting compact vault context:", error);
			return "Context unavailable";
		}
	}
	
	// Original full context method kept for other uses
	private async getVaultContext(): Promise<string> {
		try {
			const allFiles = this.app.vault.getMarkdownFiles();
			const recentFiles = allFiles
				.sort((a, b) => b.stat.mtime - a.stat.mtime)
				.slice(0, 10); // Get last 10 modified files
			
			let context = "Recent notes:\n";
			
			for (const file of recentFiles) {
				try {
					const content = await this.app.vault.read(file);
					const title = file.basename;
					const tags = this.extractTags(content);
					const tasks = this.extractTasks(content);
					const links = this.extractLinks(content);
					
					context += `- ${title}: tags=${tags.join(",")}, tasks=${tasks.length}, links=${links.join(",")}\n`;
				} catch (error) {
					console.log(`Could not read file ${file.path}:`, error);
				}
			}
			
			// Add entity summary
			const entities = await this.extractEntities(allFiles);
			if (entities.length > 0) {
				context += "\nEntity notes:\n";
				for (const entity of entities) {
					context += `- ${entity.name}: ${entity.count} references\n`;
				}
			}
			
			return context;
		} catch (error) {
			console.error("Error getting vault context:", error);
			return "Vault context unavailable";
		}
	}
	
	private extractTags(content: string): string[] {
		const tagRegex = /#(\w+)/g;
		const matches = content.match(tagRegex);
		return matches ? matches.map(tag => tag.substring(1)) : [];
	}
	
	private extractTasks(content: string): string[] {
		const taskRegex = /- \[([ x])\] (.+)/g;
		const matches = content.match(taskRegex);
		return matches ? matches.map(task => task[2]) : [];
	}
	
	private extractLinks(content: string): string[] {
		const linkRegex = /\[\[([^\]]+)\]\]/g;
		const matches = content.match(linkRegex);
		return matches ? matches.map(link => link.substring(2, link.length - 2)) : [];
	}
	
	private async extractEntities(files: any[]): Promise<Array<{name: string, count: number}>> {
		const entityCounts = new Map<string, number>();
		
		for (const file of files) {
			try {
				const content = await this.app.vault.read(file);
				const entities = this.extractLinks(content);
				for (const entity of entities) {
					entityCounts.set(entity, (entityCounts.get(entity) || 0) + 1);
				}
			} catch (error) {
				// Skip files that can't be read
			}
		}
		
		return Array.from(entityCounts.entries())
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 5); // Top 5 entities
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
			.setDesc("Stored locally. Used for Whisper and GPT calls over HTTPS.")
			.addText((text) =>
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = (value || '').trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Whisper model")
			.setDesc("Model for transcription.")
			.addDropdown((drop) =>
				drop
					.addOption("gpt-4o-transcribe", "gpt-4o-transcribe (default)")
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

		// Transcription Languages section
		containerEl.createEl("h3", { text: "Transcription Languages" });
		containerEl.createEl("p", { 
			text: "Select languages for transcription. If multiple are selected, auto-detection will be used first, then fallback to individual languages if needed.",
			cls: "setting-item-description"
		});
		
		const languagesContainer = containerEl.createDiv("languages-container");
		
		SUPPORTED_LANGUAGES.forEach((lang) => {
			const setting = new Setting(languagesContainer)
				.setName(lang.name)
				.addToggle((toggle) => {
					const isChecked = this.plugin.settings.transcriptionLanguages.includes(lang.code);
					toggle.setValue(isChecked);
					toggle.onChange(async (value) => {
						if (value) {
							if (!this.plugin.settings.transcriptionLanguages.includes(lang.code)) {
								this.plugin.settings.transcriptionLanguages.push(lang.code);
							}
						} else {
							this.plugin.settings.transcriptionLanguages = this.plugin.settings.transcriptionLanguages.filter(
								(code) => code !== lang.code
							);
						}
						await this.plugin.saveSettings();
					});
				});
		});
	}
}