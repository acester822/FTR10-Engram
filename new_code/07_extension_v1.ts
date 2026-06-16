import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const PROXY_URL = 'http://localhost:8080/v1/chat/completions';

export function activate(context: vscode.ExtensionContext) {
	console.log('🧠 Engram extension is now active!');

	// 1. Register the Chat Participant
	const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken) => {
		
		// 2. Gather Hyper-Local Context (Things the proxy can't see)
		const localContext = await gatherLocalContext();
		
		// 3. Format the payload for our Smart Proxy
		const messages = [
			{ role: 'system', content: `You are Engram, an AI assistant with access to the user's long-term cognitive memory. Local Context: ${localContext}` },
			{ role: 'user', content: request.prompt }
		];

		stream.progress('🧠 Querying Engram memory engine...');

		try {
			// 4. Fetch from the Smart Proxy
			const response = await fetch(PROXY_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages,
					stream: true,
					model: 'proxy' // Proxy ignores this and uses its configured LLM
				})
			});

			if (!response.ok || !response.body) {
				throw new Error(`Proxy failed with status ${response.status}`);
			}

			// 5. Handle Server-Sent Events (SSE) Streaming
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let fullResponseText = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				
				// Keep the last incomplete line in the buffer for the next iteration
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (line.startsWith('data: ')) {
						const dataStr = line.slice(6).trim();
						if (dataStr === '[DONE]') continue;

						try {
							const json = JSON.parse(dataStr);
							const content = json.choices?.[0]?.delta?.content || '';
							
							if (content) {
								fullResponseText += content;
								stream.markdown(content); // Stream to VS Code UI
							}
						} catch (e) {
							// Ignore JSON parse errors on incomplete chunks
						}
					}
				}
			}

			// 6. Render the Explainable Trace (Collapsible UI)
			// We append this at the end of the stream. 
			// (See note below on how the proxy injects this trace data)
			renderCognitiveTrace(stream, fullResponseText);

		} catch (error: any) {
			stream.markdown(`❌ **Engram Error**: ${error.message}\n\n*Is the Engram proxy running on port 8080?*`);
	  	}
	};

	const participant = vscode.chat.createChatParticipant('engram.cortex', handler);
	participant.iconPath = new vscode.ThemeIcon('brain'); // Native VS Code brain icon
	
	context.subscriptions.push(participant);
}

/**
 * Gathers workspace-specific context to send alongside the user prompt.
 */
async function gatherLocalContext(): Promise<string> {
	let context = '';

	// 1. Active File Context
	const editor = vscode.window.activeTextEditor;
	if (editor) {
		const fileName = path.basename(editor.document.fileName);
		const language = editor.document.languageId;
		// Grab first 15 lines to give the LLM a hint of the file structure without blowing up tokens
		const snippet = editor.document.getText(new vscode.Range(0, 0, 15, 0)).trim();
		context += `\n- Active File: ${fileName} (${language})\n- Snippet:\n${snippet}\n`;
	}

	// 2. Git Branch Context
	try {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceFolder) {
			const branch = execSync('git branch --show-current', { cwd: workspaceFolder, encoding: 'utf-8' }).trim();
			context += `\n- Current Git Branch: ${branch}\n`;
		}
	} catch (e) {
		// Not a git repo or git not installed, ignore
	}

	return context.trim() || 'No specific local workspace context available.';
}

/**
 * Appends a collapsible "Explainable Trace" to the chat response.
 * Note: For this to be truly dynamic, your proxy should append a special 
 * SSE event at the end of the stream, or you can fetch the last DB entry.
 * For this MVP, we simulate the trace based on the proxy's known behavior.
 */
function renderCognitiveTrace(stream: vscode.ChatResponseStream, responseText: string) {
	// In a full implementation, the proxy would send a custom SSE event like:
	// event: engram_trace
	// data: {"genome": ["Prefers Python"], "phenotype": ["Debugged JWT yesterday"]}
	
	// For now, we render a static-structured collapsible block that proves the concept.
	// VS Code natively renders <details> and <summary> as collapsible UI!
	const traceMarkdown = `

---
<details>
<summary>🧠 <b>Engram Memory Trace</b> (Click to expand)</summary>
<br>
<b>✅ Genome (Immutable):</b>
<ul>
  <li>User prefers functional React components.</li>
  <li>Project uses PostgreSQL and TypeScript.</li>
</ul>
<br>
<b>🔄 Phenotype (Recalled Context):</b>
<ul>
  <li><i>[Episodic]</i> User struggled with JWT refresh tokens yesterday.</li>
  <li><i>[Procedural]</i> Always run \`npm run lint\` before committing.</li>
</ul>
<br>
<i>💡 These memories were implicitly injected into the LLM's system prompt before it generated this response.</i>
</details>
`;
	
	stream.markdown(traceMarkdown);
}

export function deactivate() {}
