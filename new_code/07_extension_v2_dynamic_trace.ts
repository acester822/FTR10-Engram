import * as vscode from 'vscode';
import * as path from 'path';
import { execSync } from 'child_process';

const PROXY_URL = 'http://localhost:8080/v1/chat/completions';

// Interface for the trace data sent by the proxy
interface CognitiveTrace {
  genome: string[];
  phenotype: { sector: string; content: string; score: number }[];
}

export function activate(context: vscode.ExtensionContext) {
	console.log('🧠 Engram extension is now active!');

	const handler: vscode.ChatRequestHandler = async (
		request: vscode.ChatRequest, 
		chatContext: vscode.ChatContext, 
		stream: vscode.ChatResponseStream, 
		token: vscode.CancellationToken
	) => {
		const localContext = await gatherLocalContext();
		
		const messages = [
			{ role: 'system', content: `You are Engram. Local Context: ${localContext}` },
			{ role: 'user', content: request.prompt }
		];

		stream.progress('🧠 Querying Engram memory engine...');

		let dynamicTrace: CognitiveTrace | null = null;

		try {
			const response = await fetch(PROXY_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages,
					stream: true,
					model: 'proxy'
				})
			});

			if (!response.ok || !response.body) {
				throw new Error(`Proxy failed with status ${response.status}`);
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				
				// SSE messages are separated by double newlines (\n\n)
				const messages = buffer.split('\n\n');
				
				// Keep the last incomplete chunk in the buffer for the next iteration
				buffer = messages.pop() || '';

				for (const msg of messages) {
					if (!msg.trim()) continue;

					let eventType = 'message'; // Default SSE event type
					let eventData = '';

					// Parse individual lines within the SSE message block
					const lines = msg.split('\n');
					for (const line of lines) {
						if (line.startsWith('event: ')) {
							eventType = line.slice(7).trim();
						} else if (line.startsWith('data: ')) {
							eventData = line.slice(6).trim();
						}
					}

					// Handle Standard LLM Streaming Chunks
					if (eventType === 'message' && eventData !== '[DONE]') {
						try {
							const json = JSON.parse(eventData);
							const content = json.choices?.[0]?.delta?.content || '';
							if (content) {
								stream.markdown(content);
							}
						} catch (e) {
							// Ignore JSON parse errors on partial chunks
						}
					} 
					// Handle Custom Engram Trace Event
					else if (eventType === 'engram_trace') {
						try {
							dynamicTrace = JSON.parse(eventData) as CognitiveTrace;
						} catch (e) {
							console.error('[Engram] Failed to parse trace data:', e);
						}
					}
				}
			}

			// 6. Render the Dynamic Explainable Trace AFTER the stream finishes
			if (dynamicTrace) {
				renderDynamicCognitiveTrace(stream, dynamicTrace);
			} else {
				// Fallback if proxy didn't send a trace (e.g., first run with no memories)
				stream.markdown('\n\n---\n<i>💡 No specific long-term memories were triggered for this request.</i>');
			}

		} catch (error: any) {
			stream.markdown(`❌ **Engram Error**: ${error.message}\n\n*Is the Engram proxy running on port 8080?*`);
		}
	};

	const participant = vscode.chat.createChatParticipant('engram.cortex', handler);
	participant.iconPath = new vscode.ThemeIcon('brain');
	
	context.subscriptions.push(participant);
}

/**
 * Gathers workspace-specific context to send alongside the user prompt.
 */
async function gatherLocalContext(): Promise<string> {
	let context = '';

	const editor = vscode.window.activeTextEditor;
	if (editor) {
		const fileName = path.basename(editor.document.fileName);
		const language = editor.document.languageId;
		const snippet = editor.document.getText(new vscode.Range(0, 0, 15, 0)).trim();
		context += `\n- Active File: ${fileName} (${language})\n- Snippet:\n${snippet}\n`;
	}

	try {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceFolder) {
			const branch = execSync('git branch --show-current', { cwd: workspaceFolder, encoding: 'utf-8' }).trim();
			context += `\n- Current Git Branch: ${branch}\n`;
		}
	} catch (e) {
		// Ignore git errors
	}

	return context.trim() || 'No specific local workspace context available.';
}

/**
 * Renders a 100% dynamic, collapsible Explainable Trace based on proxy data.
 */
function renderDynamicCognitiveTrace(stream: vscode.ChatResponseStream, trace: CognitiveTrace) {
	let markdown = `\n\n---\n<details>\n<summary>🧠 <b>Engram Memory Trace</b> (Click to expand)</summary>\n<br>\n`;

	// Render Genome
	if (trace.genome && trace.genome.length > 0) {
		markdown += `<b>✅ Genome (Immutable Directives):</b>\n<ul>\n`;
		trace.genome.forEach(fact => {
			markdown += `  <li>${escapeHtml(fact)}</li>\n`;
		});
		markdown += `</ul>\n<br>\n`;
	} else {
		markdown += `<b>✅ Genome:</b> <i>None active</i><br>\n`;
	}

	// Render Phenotype
	if (trace.phenotype && trace.phenotype.length > 0) {
		markdown += `<b>🔄 Phenotype (Recalled Context):</b>\n<ul>\n`;
		trace.phenotype.forEach(mem => {
			const sectorLabel = mem.sector.charAt(0).toUpperCase() + mem.sector.slice(1);
			markdown += `  <li><i>[${sectorLabel}]</i> ${escapeHtml(mem.content)}</li>\n`;
		});
		markdown += `</ul>\n`;
	} else {
		markdown += `<b>🔄 Phenotype:</b> <i>No contextual memories matched</i>\n`;
	}

	markdown += `<br>\n<i>💡 These memories were implicitly injected into the LLM's system prompt before generation.</i>\n</details>\n`;
	
	stream.markdown(markdown);
}

/**
 * Simple HTML escaper to prevent XSS or broken markdown in the UI
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

export function deactivate() {}
