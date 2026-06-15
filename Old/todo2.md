Here is the fully refined, production-ready **SSE parsing logic** for your VS Code extension. 

By switching to a proper Server-Sent Events (SSE) parser that respects the `event:` and `data:` prefixes (separated by `\n\n`), the extension can now seamlessly distinguish between standard LLM text chunks and your custom `codecortex_trace` payload.

Replace your existing `src/extension.ts` with this updated version.

---

### The Updated `extension.ts` (Dynamic Trace Parsing)

```typescript
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
	console.log('🧠 CodeCortex extension is now active!');

	const handler: vscode.ChatRequestHandler = async (
		request: vscode.ChatRequest, 
		chatContext: vscode.ChatContext, 
		stream: vscode.ChatResponseStream, 
		token: vscode.CancellationToken
	) => {
		const localContext = await gatherLocalContext();
		
		const messages = [
			{ role: 'system', content: `You are CodeCortex. Local Context: ${localContext}` },
			{ role: 'user', content: request.prompt }
		];

		stream.progress('🧠 Querying CodeCortex memory engine...');

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
					// Handle Custom CodeCortex Trace Event
					else if (eventType === 'codecortex_trace') {
						try {
							dynamicTrace = JSON.parse(eventData) as CognitiveTrace;
						} catch (e) {
							console.error('[CodeCortex] Failed to parse trace data:', e);
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
			stream.markdown(`❌ **CodeCortex Error**: ${error.message}\n\n*Is the CodeCortex proxy running on port 8080?*`);
		}
	};

	const participant = vscode.chat.createChatParticipant('openmemory.cortex', handler);
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
	let markdown = `\n\n---\n<details>\n<summary>🧠 <b>CodeCortex Memory Trace</b> (Click to expand)</summary>\n<br>\n`;

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
```

---

### Why This Parser is Robust
1. **`\n\n` Delimiter**: Standard SSE dictates that messages are separated by double newlines. Splitting by `\n\n` guarantees we never try to parse a partial JSON chunk, eliminating the `Unexpected end of JSON input` errors that plague naive SSE parsers.
2. **Event Routing**: It explicitly checks for `event: codecortex_trace`. If the proxy sends standard OpenAI chunks (`event: message` or no event), it routes them to `stream.markdown()`. If it sends the trace, it saves it to a variable and waits until the stream is fully complete to render the UI.
3. **Graceful Degradation**: If the proxy fails to send a trace (e.g., the database is empty), the `if (dynamicTrace)` check fails gracefully, and it renders a polite fallback message instead of crashing or showing broken UI.

---

### The Required Proxy-Side Handshake (Double Check)
For this extension code to work, your Node.js proxy (`packages/openmemory-js/src/server/index.ts`) **must** format the end of its stream exactly like this. 

Ensure your proxy route ends with this logic right before `res.end()`:

```typescript
// ... inside your proxy route, after the while(reader.read()) loop finishes ...

// 1. Gather the trace data that was used for THIS specific request
// (Assuming you saved these during the memoryInjector.buildCognitiveContext step)
const tracePayload = {
  genome: genomeMemories.map(m => m.content),
  phenotype: phenotypeMemories.map(m => ({ 
    sector: m.sector, 
    content: m.content, 
    score: Number(m.finalScore.toFixed(2)) 
  }))
};

// 2. Send the custom SSE event. Note the \n\n at the end!
const traceDataString = JSON.stringify(tracePayload);
res.write(`event: codecortex_trace\ndata: ${traceDataString}\n\n`);

// 3. Close the stream
res.end();
```