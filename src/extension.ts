import * as vscode from 'vscode';
import axios from 'axios';
import * as path from 'path';
import * as fs from 'fs';

// Types
interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}

interface UserSettings {
    customInstructions: string;
    modelPreference: string;
    autoApplySuggestions: boolean;
}

interface FileChange {
    filePath: string;
    originalContent: string;
    newContent: string;
    startLine?: number;
    endLine?: number;
    action: 'replace' | 'create' | 'delete';
}

interface MultiFileEdit {
    changes: FileChange[];
    summary: string;
}

// Global state
let currentSelection: {
    code: string;
    lineStart: number;
    lineEnd: number;
    filePath: string;
} | null = null;

let currentPanel: vscode.WebviewPanel | null = null;
let chatHistory: ChatMessage[] = [];
let extensionContext: vscode.ExtensionContext | null = null;
let lastMultiFileEdit: MultiFileEdit | null = null;

let settings: UserSettings = {
    customInstructions: '',
    modelPreference: 'auto',
    autoApplySuggestions: false
};
let lastActiveEditor: vscode.TextEditor | undefined = undefined;
// Get server URL from config
function getServerUrl(): string {
    const config = vscode.workspace.getConfiguration('ai-assistant');
    return config.get<string>('serverUrl') || 'http://192.168.1.13:8001';
}

export function activate(extContext: vscode.ExtensionContext) {
    extensionContext = extContext;
    console.log('AI Code Assistant activated');

    loadSettings();
    loadHistory();
    registerCommands();
    registerCodeActions();
    registerNotebookSupport();
    setupPreCommitHook();
    createStatusBarItem();

    // Add button to editor title bar (top right of each editor)
    const aiTitleButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
    aiTitleButton.text = "$(hubot) AI";
    aiTitleButton.tooltip = "Open AI Assistant (ask anything)";
    aiTitleButton.command = "ai-code-assistant.openPanel";
    aiTitleButton.show();
    extensionContext.subscriptions.push(aiTitleButton);
}

function loadSettings() {
    if (extensionContext) {
        const saved = extensionContext.workspaceState.get<UserSettings>('settings', {
            customInstructions: '',
            modelPreference: 'auto',
            autoApplySuggestions: false
        });
        settings = saved;
    }
}

function saveSettings() {
    if (extensionContext) {
        extensionContext.workspaceState.update('settings', settings);
    }
}

function loadHistory() {
    if (extensionContext) {
        const saved = extensionContext.workspaceState.get<ChatMessage[]>('chatHistory', []);
        chatHistory = saved;
    }
}

function saveHistory() {
    if (extensionContext) {
        if (chatHistory.length > 100) {
            chatHistory = chatHistory.slice(-100);
        }
        extensionContext.workspaceState.update('chatHistory', chatHistory);
    }
}

function addToHistory(role: 'user' | 'assistant', content: string) {
    chatHistory.push({ role, content, timestamp: Date.now() });
    saveHistory();
    if (currentPanel) {
        currentPanel.webview.postMessage({
            command: 'updateHistory',
            history: chatHistory.slice(-20).map(msg => ({
                role: msg.role,
                content: msg.content.substring(0, 200),
                timestamp: new Date(msg.timestamp).toLocaleTimeString()
            }))
        });
    }
}

function createStatusBarItem() {
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.text = "$(sync~spin) AI: Connecting...";
    statusBar.show();
    statusBar.command = 'ai-code-assistant.reconnect';

    async function checkConnection() {
        try {
            await axios.get(`${getServerUrl()}/health`, { timeout: 5000 });
            statusBar.text = "$(check) AI: Connected";
            statusBar.tooltip = "AI Server is online";
            statusBar.backgroundColor = undefined;
        } catch {
            statusBar.text = "$(warning) AI: Offline";
            statusBar.tooltip = "Cannot connect to AI server";
            statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
    }

    checkConnection();
    setInterval(checkConnection, 30000);
    extensionContext?.subscriptions.push(statusBar);
}
async function handlePromptStreaming(prompt: string, panel: vscode.WebviewPanel) {
    console.log('1. handlePromptStreaming STARTED with:', prompt);
    const currentEditor = vscode.window.activeTextEditor;
    if (currentEditor) {
        lastActiveEditor = currentEditor;
        console.log('Stored active editor:', currentEditor.document.fileName);
    } else {
        console.log('No active editor found when sending prompt');
    }
    lastActiveEditor = vscode.window.activeTextEditor;
    try {
        console.log('2. Processing slash commands...');
        const processed = processSlashCommands(prompt, panel);
        console.log('3. Processed result:', processed);
        if (processed === null) {
            console.log('4. Processed is null, returning');
            return;
        }

        console.log('5. Processing file references...');
        const referencedPrompt = await processFileReferences(processed, panel);
        console.log('6. Referenced prompt:', referencedPrompt);

        console.log('7. Adding to history...');
        addToHistory('user', referencedPrompt);

        console.log('8. Sending thinking and clearResponse...');
        panel.webview.postMessage({ command: 'thinking', thinking: true });
        panel.webview.postMessage({ command: 'clearResponse', clear: true });

        let fullPrompt: string;
        console.log('9. currentSelection:', currentSelection ? 'exists' : 'null');

        if (currentSelection) {
            fullPrompt = `Context: ${currentSelection.lineStart === 1 && currentSelection.lineEnd === currentSelection.code.split('\n').length ? 'Full file' : `Lines ${currentSelection.lineStart}-${currentSelection.lineEnd}`} from ${currentSelection.filePath.split(/[\\/]/).pop()}

Code:
\`\`\`
${currentSelection.code}
\`\`\`

User Instruction: ${referencedPrompt}

Respond with markdown. Show complete modified code blocks.`;
        } else {
            fullPrompt = referencedPrompt;
        }
        console.log('10. Full prompt length:', fullPrompt.length);

        const serverUrl = getServerUrl();
        console.log('11. Server URL:', serverUrl);

        const streamUrl = `${serverUrl}/process/stream`;
        console.log('12. Fetching from:', streamUrl);

        const response = await fetch(streamUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: fullPrompt, task_type: 'chat' })
        });
        console.log('13. Response status:', response.status);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let accumulated = '';
        console.log('14. Starting to read stream...');

        while (reader) {
            const { done, value } = await reader.read();
            if (done) { break; }
            const chunk = decoder.decode(value);
            accumulated += chunk;
            panel.webview.postMessage({ command: 'streamChunk', chunk: chunk, full: accumulated });
        }
        console.log('15. Stream complete, length:', accumulated.length);

        addToHistory('assistant', accumulated);
        panel.webview.postMessage({ command: 'streamComplete', response: accumulated });

        if (settings.autoApplySuggestions && currentSelection) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.fileName === currentSelection.filePath) {
                const codeMatch = accumulated.match(/```[\w]*\n([\s\S]*?)```/);
                const applyCode = codeMatch ? codeMatch[1] : accumulated;
                const langId = editor.document.languageId;
                const ts = Date.now();
                const sel = currentSelection;

                const originalUri = vscode.Uri.parse(`untitled:Original-${ts}.${langId}`);
                const modifiedUri = vscode.Uri.parse(`untitled:AI-Suggestion-${ts}.${langId}`);

                const origDoc = await vscode.workspace.openTextDocument(originalUri);
                const origEdit = await vscode.window.showTextDocument(origDoc, { preview: true });
                await origEdit.edit(b => b.insert(new vscode.Position(0, 0), sel.code));

                const modDoc = await vscode.workspace.openTextDocument(modifiedUri);
                const modEdit = await vscode.window.showTextDocument(modDoc, { preview: true });
                await modEdit.edit(b => b.insert(new vscode.Position(0, 0), applyCode));

                await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, 'AI Suggestion — Review Changes');

                const choice = await vscode.window.showInformationMessage(
                    'Apply this AI suggestion?',
                    { modal: false },
                    '✅ Accept',
                    '❌ Reject'
                );

                if (choice === '✅ Accept') {
                    const startLine = sel.lineStart - 1;
                    const endLine = sel.lineEnd - 1;
                    if (endLine < editor.document.lineCount) {
                        const range = new vscode.Range(
                            startLine, 0,
                            endLine, editor.document.lineAt(endLine).text.length
                        );
                        await editor.edit(editBuilder => {
                            editBuilder.replace(range, applyCode);
                        });
                    }
                    panel.webview.postMessage({
                        command: 'appendSystemMessage',
                        message: '✅ Changes applied'
                    });
                } else {
                    panel.webview.postMessage({
                        command: 'appendSystemMessage',
                        message: '❌ Changes rejected'
                    });
                }
            }
        }

    } catch (error: any) {
        console.error('ERROR in handlePromptStreaming:', error);
        panel.webview.postMessage({
            command: 'errorWithRetry',
            error: error.message,
            originalPrompt: prompt
        });
    } finally {
        console.log('16. Finally block - hiding thinking');
        panel.webview.postMessage({ command: 'thinking', thinking: false });
    }
}
function registerCommands() {
    if (!extensionContext) { return; }

    // Add selected code to AI
    const addToAI = vscode.commands.registerCommand('ai-code-assistant.addToAI', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        // Store the active editor for button operations
        lastActiveEditor = editor;

        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showErrorMessage('Please select some code first');
            return;
        }

        currentSelection = {
            code: editor.document.getText(selection),
            lineStart: selection.start.line + 1,
            lineEnd: selection.end.line + 1,
            filePath: editor.document.fileName
        };

        const panel = createOrShowAIPanel();

        if (currentSelection) {
            panel.webview.postMessage({
                command: 'selectionLoaded',
                code: currentSelection.code,
                lineStart: currentSelection.lineStart,
                lineEnd: currentSelection.lineEnd,
                fileName: currentSelection.filePath.split(/[\\/]/).pop(),
                isFullFile: false
            });
        } else {
            vscode.window.showErrorMessage('Failed to load selection');
            return;
        }
    });

    // Open AI Assistant without code selection (text-only chat)
    const openPanel = vscode.commands.registerCommand('ai-code-assistant.openPanel', () => {
        // Store the active editor if available
        lastActiveEditor = vscode.window.activeTextEditor;

        currentSelection = null;
        const panel = createOrShowAIPanel();
        panel.webview.postMessage({
            command: 'appendSystemMessage',
            message: '💬 No code selected. Type your question or request below.'
        });
    });

    // Add entire file to AI
    const addFileToAI = vscode.commands.registerCommand('ai-code-assistant.addFileToAI', async (uri: vscode.Uri) => {
        if (!uri) { return; }

        // Store the active editor
        lastActiveEditor = vscode.window.activeTextEditor;

        try {
            const fileContent = await vscode.workspace.fs.readFile(uri);
            const content = Buffer.from(fileContent).toString('utf8');
            const fileName = uri.path.split('/').pop() || 'unknown';
            const lines = content.split('\n').length;

            currentSelection = {
                code: content,
                lineStart: 1,
                lineEnd: lines,
                filePath: uri.fsPath
            };

            const panel = createOrShowAIPanel();

            if (currentSelection) {
                panel.webview.postMessage({
                    command: 'selectionLoaded',
                    code: content.length > 10000 ? content.substring(0, 10000) + '\n\n... (file truncated)' : content,
                    lineStart: 1,
                    lineEnd: lines,
                    fileName: fileName,
                    isFullFile: true,
                    totalLines: lines,
                    truncated: content.length > 10000
                });
            }

            panel.webview.postMessage({
                command: 'appendSystemMessage',
                message: `📄 Full file '${fileName}' loaded (${lines} lines)`
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to read file: ${error.message}`);
        }
    });

    // Clear chat history
    const clearHistory = vscode.commands.registerCommand('ai-code-assistant.clearHistory', () => {
        chatHistory = [];
        saveHistory();
        if (currentPanel) {
            currentPanel.webview.postMessage({ command: 'clearHistory' });
        }
        vscode.window.showInformationMessage('Chat history cleared');
    });

    // Review Pull Request
    const reviewPR = vscode.commands.registerCommand('ai-code-assistant.reviewPR', async () => {
        const prUrl = await vscode.window.showInputBox({
            prompt: 'Enter GitHub PR URL',
            placeHolder: 'https://github.com/owner/repo/pull/123'
        });

        if (!prUrl) { return; }

        vscode.window.showInformationMessage('🔍 Analyzing pull request...');

        try {
            const match = prUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
            if (!match) { throw new Error('Invalid GitHub PR URL'); }

            const [, owner, repo, prNumber] = match;
            const diff = await fetchGitHubPRDiff(owner, repo, prNumber);

            currentSelection = {
                code: diff,
                lineStart: 1,
                lineEnd: diff.split('\n').length,
                filePath: 'pull-request.diff'
            };

            const panel = createOrShowAIPanel();

            if (currentSelection) {
                panel.webview.postMessage({
                    command: 'selectionLoaded',
                    code: diff.substring(0, 5000),
                    lineStart: 1,
                    lineEnd: diff.split('\n').length,
                    fileName: 'pull-request.diff',
                    isFullFile: true
                });
            }

            const reviewPrompt = `Please review this pull request diff. Provide feedback on:
1. Code quality and style
2. Potential bugs
3. Performance concerns
4. Security issues
5. Specific improvement suggestions`;

            await handlePromptStreaming(reviewPrompt, panel);

        } catch (error: any) {
            vscode.window.showErrorMessage(`PR review failed: ${error.message}`);
        }
    });

    // Post PR Comment
    const postPRComment = vscode.commands.registerCommand('ai-code-assistant.postPRComment', async () => {
        const prUrl = await vscode.window.showInputBox({
            prompt: 'Enter GitHub PR URL',
            placeHolder: 'https://github.com/owner/repo/pull/123'
        });

        if (!prUrl) { return; }

        const comment = await vscode.window.showInputBox({
            prompt: 'Enter your review comment',
            placeHolder: 'Comment to post on PR'
        });

        if (!comment) { return; }

        try {
            const match = prUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
            if (!match) { throw new Error('Invalid URL'); }

            const [, owner, repo, prNumber] = match;
            await postGitHubPRComment(owner, repo, prNumber, comment);
            vscode.window.showInformationMessage('Comment posted to PR');
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to post comment: ${error.message}`);
        }
    });

    // Configure settings
    const configureSettings = vscode.commands.registerCommand('ai-code-assistant.configureSettings', async () => {
        const customInstructions = await vscode.window.showInputBox({
            prompt: 'Custom instructions for AI',
            value: settings.customInstructions,
            placeHolder: 'e.g., "Always use TypeScript, prefer async/await"'
        });

        if (customInstructions !== undefined) {
            settings.customInstructions = customInstructions;
            saveSettings();
            vscode.window.showInformationMessage('Settings saved');
        }
    });

    // Multi-file edit
    const multiFileEdit = vscode.commands.registerCommand('ai-code-assistant.multiFileEdit', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);

        if (!selectedText) {
            vscode.window.showErrorMessage('Please select code to refactor across files');
            return;
        }

        const prompt = await vscode.window.showInputBox({
            prompt: 'Describe the multi-file change',
            placeHolder: 'Move this function to utils.js and update all imports'
        });

        if (!prompt) { return; }

        vscode.window.showInformationMessage('🔍 Analyzing for multi-file changes...');

        const fullPrompt = `You are an AI that plans multi-file code changes. Output JSON only.
Selected code: ${selectedText}
Request: ${prompt}
Output format: {"summary": "...", "changes": [{"filePath": "...", "action": "replace", "startLine": 1, "endLine": 10, "newContent": "..."}]}`;

        try {
            const response = await axios.post(`${getServerUrl()}/process`, {
                prompt: fullPrompt,
                task_type: 'code',
                max_tokens: 4096
            });

            const jsonMatch = response.data.result.match(/\{[\s\S]*\}/);
            if (!jsonMatch) { throw new Error('Could not parse AI response'); }

            const plan: MultiFileEdit = JSON.parse(jsonMatch[0]);
            await showMultiFilePreview(plan);

        } catch (error: any) {
            vscode.window.showErrorMessage(`Multi-file edit failed: ${error.message}`);
        }
    });

    // Rollback edit
    const rollbackEdit = vscode.commands.registerCommand('ai-code-assistant.rollbackEdit', async () => {
        if (!lastMultiFileEdit) {
            vscode.window.showInformationMessage('No multi-file edit to rollback');
            return;
        }
        await rollbackMultiFileEdit();
        lastMultiFileEdit = null;
        vscode.window.showInformationMessage('Rollback complete');
    });

    // Export history
    const exportHistory = vscode.commands.registerCommand('ai-code-assistant.exportHistory', async () => {
        if (!chatHistory.length) {
            vscode.window.showWarningMessage('No chat history to export');
            return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const defaultFileName = `ai-chat-history-${timestamp}.json`;

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultFileName),
            filters: { 'JSON files': ['json'] }
        });

        if (uri) {
            const data = JSON.stringify(chatHistory, null, 2);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(data, 'utf8'));
            vscode.window.showInformationMessage(`History exported`);
        }
    });

    // Import history
    const importHistory = vscode.commands.registerCommand('ai-code-assistant.importHistory', async () => {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'JSON files': ['json'] }
        });

        if (uris && uris[0]) {
            try {
                const content = await vscode.workspace.fs.readFile(uris[0]);
                const imported = JSON.parse(Buffer.from(content).toString('utf8'));

                if (Array.isArray(imported)) {
                    chatHistory = [...chatHistory, ...imported];
                    saveHistory();
                    if (currentPanel) {
                        currentPanel.webview.postMessage({
                            command: 'updateHistory',
                            history: chatHistory.slice(-20).map(msg => ({
                                role: msg.role,
                                content: msg.content.substring(0, 200),
                                timestamp: new Date(msg.timestamp).toLocaleTimeString()
                            }))
                        });
                    }
                    vscode.window.showInformationMessage(`Imported ${imported.length} messages`);
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`Import failed: ${error.message}`);
            }
        }
    });

    // Reconnect
    const reconnect = vscode.commands.registerCommand('ai-code-assistant.reconnect', async () => {
        vscode.window.showInformationMessage('Checking connection...');
        if (currentPanel) {
            await handlePromptStreaming('/help', currentPanel);
        }
    });

    extensionContext.subscriptions.push(
        addToAI, openPanel, addFileToAI, clearHistory, reviewPR, postPRComment,
        configureSettings, multiFileEdit, rollbackEdit, exportHistory,
        importHistory, reconnect
    );
}

function registerCodeActions() {
    const provideCodeActions = vscode.languages.registerCodeActionsProvider(
        { pattern: '**/*.{js,ts,jsx,tsx,py,go,rs}' },
        {
            provideCodeActions(document, range) {
                const code = document.getText(range);
                if (!code || code.length < 5) { return []; }

                const actions = [];

                const explainAction = new vscode.CodeAction('🤖 AI: Explain this code', vscode.CodeActionKind.QuickFix);
                explainAction.command = { command: 'ai-code-assistant.addToAI', title: 'Explain Code' };
                actions.push(explainAction);

                const fixAction = new vscode.CodeAction('🔧 AI: Fix this code', vscode.CodeActionKind.QuickFix);
                fixAction.command = { command: 'ai-code-assistant.addToAI', title: 'Fix Code' };
                actions.push(fixAction);

                const testAction = new vscode.CodeAction('🧪 AI: Generate test', vscode.CodeActionKind.QuickFix);
                testAction.command = { command: 'ai-code-assistant.addToAI', title: 'Generate Test' };
                actions.push(testAction);

                return actions;
            }
        }
    );
    extensionContext?.subscriptions.push(provideCodeActions);
}

function registerNotebookSupport() {
    const notebookProvider = vscode.workspace.onDidOpenNotebookDocument(async (document) => {
        const shouldAssist = await vscode.window.showInformationMessage(
            'Open AI Assistant for this notebook?',
            'Yes', 'No'
        );

        if (shouldAssist === 'Yes') {
            const content = document.getCells().map(cell => cell.document.getText()).join('\n\n');
            currentSelection = {
                code: content,
                lineStart: 1,
                lineEnd: content.split('\n').length,
                filePath: document.uri.fsPath
            };
            createOrShowAIPanel();
        }
    });
    extensionContext?.subscriptions.push(notebookProvider);
}

function setupPreCommitHook() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) { return; }

    const hookPath = path.join(workspaceFolder, '.git', 'hooks', 'pre-commit');
    if (fs.existsSync(path.dirname(hookPath)) && !fs.existsSync(hookPath)) {
        const hookContent = `#!/bin/bash
# AI Assistant Pre-commit Hook
echo "Running AI pre-commit checks..."
if git diff --cached | grep -E "(password|secret|api_key|token)" ; then
    echo "⚠️ Warning: Possible sensitive data being committed"
    read -p "Continue? (y/n) " -n 1 -r
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi
echo "Pre-commit checks passed"`;

        fs.writeFileSync(hookPath, hookContent);
        fs.chmodSync(hookPath, 0o755);
    }
}

async function fetchGitHubPRDiff(owner: string, repo: string, prNumber: string): Promise<string> {
    const token = vscode.workspace.getConfiguration('ai-assistant').get<string>('githubToken');
    const headers: Record<string, string> = { 'Accept': 'application/vnd.github.v3.diff' };
    if (token) { headers['Authorization'] = `Bearer ${token}`; }

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
    if (!response.ok) { throw new Error(`GitHub API error: ${response.status}`); }
    return await response.text();
}

async function postGitHubPRComment(owner: string, repo: string, prNumber: string, comment: string): Promise<void> {
    const token = vscode.workspace.getConfiguration('ai-assistant').get<string>('githubToken');
    if (!token) { throw new Error('GitHub token not configured'); }

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ body: comment })
    });
    if (!response.ok) { throw new Error(`Failed to post comment: ${response.status}`); }
}

function createOrShowAIPanel(): vscode.WebviewPanel {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Beside);
        return currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
        'aiAssistant',
        '🤖 AI Assistant',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = getWebviewContent();

    panel.onDidDispose(() => { currentPanel = null; }, null, extensionContext!.subscriptions);

    panel.webview.onDidReceiveMessage(async (message) => {
        console.log('Received message:', message.command, message);

        switch (message.command) {
            // Send prompt to AI
            case 'sendPrompt':
                await handlePromptStreaming(message.prompt, panel);
                break;

            case 'retryPrompt':
                await handlePromptStreaming(message.prompt, panel);
                break;

            // REPLACE: Replaces the originally selected code using stored selection range
            case 'applyCode':
                let replaceEditor = vscode.window.activeTextEditor || lastActiveEditor;
                if (!replaceEditor) {
                    vscode.window.showErrorMessage('No active editor. Please click in the editor first.');
                    break;
                }
                const replaceCode = message.code;
                if (currentSelection && replaceEditor.document.fileName === currentSelection.filePath) {
                    const startLine = currentSelection.lineStart - 1;
                    const endLine = currentSelection.lineEnd - 1;
                    if (endLine >= replaceEditor.document.lineCount) {
                        vscode.window.showErrorMessage('Original selection range is outside document bounds. File may have changed.');
                        break;
                    }
                    const range = new vscode.Range(
                        startLine, 0,
                        endLine, replaceEditor.document.lineAt(endLine).text.length
                    );
                    replaceEditor.edit(editBuilder => {
                        editBuilder.replace(range, replaceCode);
                    });
                    vscode.window.showInformationMessage('Code replaced');
                } else if (!replaceEditor.selection.isEmpty) {
                    replaceEditor.edit(editBuilder => {
                        editBuilder.replace(replaceEditor.selection, replaceCode);
                    });
                    vscode.window.showInformationMessage('Code replaced');
                } else {
                    vscode.window.showWarningMessage('No code selected. Select code to replace, or use Insert button.');
                }
                break;

            // INSERT: Inserts at cursor position (no selection needed)
            case 'insertCode':
                const insertEditor = vscode.window.activeTextEditor || lastActiveEditor;
                if (!insertEditor) {
                    vscode.window.showErrorMessage('No active editor. Please click in the editor first.');
                    break;
                }
                const insertPosition = insertEditor.selection.active;
                const insertCode = message.code;
                insertEditor.edit(editBuilder => {
                    editBuilder.insert(insertPosition, insertCode);
                });
                vscode.window.showInformationMessage('Code inserted at cursor');
                break;

            // DIFF: Shows side-by-side diff of original vs AI suggestion
            case 'showDiff':
                const diffEditor = vscode.window.activeTextEditor || lastActiveEditor;
                if (!diffEditor) {
                    vscode.window.showErrorMessage('No active editor. Please click in the editor first.');
                    break;
                }
                const newCode = message.code;
                const languageId = diffEditor.document.languageId;
                const ts = Date.now();

                let originalCode: string;
                if (currentSelection && diffEditor.document.fileName === currentSelection.filePath) {
                    originalCode = currentSelection.code;
                } else if (!diffEditor.selection.isEmpty) {
                    originalCode = diffEditor.document.getText(diffEditor.selection);
                } else {
                    vscode.window.showWarningMessage('No original code to compare. Select code first or use Replace/Insert.');
                    break;
                }

                const originalUri = vscode.Uri.parse(`untitled:Original-${ts}.${languageId}`);
                const modifiedUri = vscode.Uri.parse(`untitled:AI-Suggestion-${ts}.${languageId}`);

                const origDoc = await vscode.workspace.openTextDocument(originalUri);
                const origEditor = await vscode.window.showTextDocument(origDoc, { preview: true });
                await origEditor.edit(editBuilder => {
                    editBuilder.insert(new vscode.Position(0, 0), originalCode);
                });

                const modDoc = await vscode.workspace.openTextDocument(modifiedUri);
                const modEditor = await vscode.window.showTextDocument(modDoc, { preview: true });
                await modEditor.edit(editBuilder => {
                    editBuilder.insert(new vscode.Position(0, 0), newCode);
                });

                await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, 'Original ↔ AI Suggestion');
                break;

            case 'copyCode':
                vscode.env.clipboard.writeText(message.code);
                vscode.window.showInformationMessage('Code copied to clipboard');
                break;

            case 'getInitialHistory':
                panel.webview.postMessage({
                    command: 'updateHistory',
                    history: chatHistory.slice(-20).map(msg => ({
                        role: msg.role,
                        content: msg.content.substring(0, 200),
                        timestamp: new Date(msg.timestamp).toLocaleTimeString()
                    }))
                });
                break;

            case 'deleteHistoryEntry':
                console.log('Deleting history entry at index:', message.index);
                const idx = message.index;
                if (idx >= 0 && idx < chatHistory.length) {
                    chatHistory.splice(idx, 1);
                    saveHistory();
                    if (currentPanel) {
                        currentPanel.webview.postMessage({
                            command: 'updateHistory',
                            history: chatHistory.slice(-20).map(msg => ({
                                role: msg.role,
                                content: msg.content.substring(0, 200),
                                timestamp: new Date(msg.timestamp).toLocaleTimeString()
                            }))
                        });
                    }
                    vscode.window.showInformationMessage('Message deleted');
                }
                break;

            case 'clearHistory':
                chatHistory = [];
                saveHistory();
                panel.webview.postMessage({ command: 'historyCleared' });
                break;

            case 'executeCommand':
                await executeTerminalCommand(message.command, panel);
                break;

            case 'searchWorkspace':
                await searchWorkspace(message.query, panel);
                break;

            case 'openFile':
                await openFile(message.path, panel);
                break;

            case 'sendVoiceInput':
                await handlePromptStreaming(message.text, panel);
                break;

            case 'sendImageInput':
                await handleImageInput(message.imageData, message.prompt, panel);
                break;

            case 'exportHistory':
                // Trigger export from registerCommands
                vscode.commands.executeCommand('ai-code-assistant.exportHistory');
                break;

            case 'importHistory':
                vscode.commands.executeCommand('ai-code-assistant.importHistory');
                break;

            case 'applyMultiFile':
                lastMultiFileEdit = message.changes;
                for (const change of message.changes) {
                    const uri = vscode.Uri.file(change.filePath);
                    if (change.action === 'create') {
                        await vscode.workspace.fs.writeFile(uri, Buffer.from(change.newContent, 'utf8'));
                    } else if (change.action === 'replace') {
                        await vscode.workspace.fs.writeFile(uri, Buffer.from(change.newContent, 'utf8'));
                    }
                }
                vscode.window.showInformationMessage('Multi-file edit applied');
                break;
        }
    });

    currentPanel = panel;
    return panel;
}

async function handleImageInput(imageData: string, prompt: string, panel: vscode.WebviewPanel) {
    if (!currentSelection) {
        panel.webview.postMessage({ command: 'error', error: 'No code selected' });
        return;
    }

    panel.webview.postMessage({ command: 'thinking', thinking: true });

    const fullPrompt = `[Image attached] User instruction: ${prompt}\n\nCode context:\n${currentSelection.code}`;

    try {
        const response = await axios.post(`${getServerUrl()}/process`, {
            prompt: fullPrompt,
            task_type: 'chat'
        });

        addToHistory('assistant', response.data.result);
        panel.webview.postMessage({ command: 'response', response: response.data.result });
    } catch (error: any) {
        panel.webview.postMessage({ command: 'error', error: error.message });
    } finally {
        panel.webview.postMessage({ command: 'thinking', thinking: false });
    }
}

async function executeTerminalCommand(command: string, panel: vscode.WebviewPanel) {
    let terminal = vscode.window.terminals.find(t => t.name === 'AI Assistant');
    if (!terminal) { terminal = vscode.window.createTerminal('AI Assistant'); }
    terminal.show();
    terminal.sendText(command);
    panel.webview.postMessage({ command: 'appendSystemMessage', message: `🖥️ Executed: ${command}` });
}

async function searchWorkspace(query: string, panel: vscode.WebviewPanel) {
    panel.webview.postMessage({ command: 'thinking', thinking: true });

    try {
        const files = await vscode.workspace.findFiles(
            '**/*.{js,ts,jsx,tsx,py,go,rs,java,cpp,c,h,html,css,json,md}',
            '**/node_modules/**,**/.git/**'
        );

        const results: { path: string; name: string; line?: number; preview?: string }[] = [];
        const searchQuery = query.toLowerCase();

        for (const file of files.slice(0, 30)) {
            try {
                const content = await vscode.workspace.fs.readFile(file);
                const text = Buffer.from(content).toString('utf8');
                const lines = text.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].toLowerCase().includes(searchQuery)) {
                        results.push({
                            path: file.fsPath,
                            name: path.basename(file.fsPath),
                            line: i + 1,
                            preview: lines[i].trim().substring(0, 100)
                        });
                        break;
                    }
                }
            } catch { }
        }

        panel.webview.postMessage({
            command: 'searchResults',
            query: query,
            results: results.slice(0, 20),
            count: results.length
        });
    } catch (error: any) {
        panel.webview.postMessage({ command: 'error', error: error.message });
    } finally {
        panel.webview.postMessage({ command: 'thinking', thinking: false });
    }
}

async function openFile(filePath: string, panel: vscode.WebviewPanel) {
    try {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);

        const lineMatch = filePath.match(/:(\d+)$/);
        if (lineMatch) {
            const line = parseInt(lineMatch[1]) - 1;
            const position = new vscode.Position(line, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position));
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to open file: ${error.message}`);
    }
}

async function processFileReferences(prompt: string, panel: vscode.WebviewPanel): Promise<string> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { return prompt; }

    const fileRefRegex = /@([\w\/\.\-\\]+)/g;
    let match;
    let processedPrompt = prompt;

    while ((match = fileRefRegex.exec(prompt)) !== null) {
        const filePath = match[1];
        const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);

        try {
            const content = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
            const fileContent = Buffer.from(content).toString('utf8');
            const truncated = fileContent.length > 50000 ? fileContent.substring(0, 50000) + '\n... (truncated)' : fileContent;
            const ext = path.extname(filePath).substring(1);
            const fileBlock = `\n\n---\n📄 **File: ${filePath}**\n\`\`\`${ext}\n${truncated}\n\`\`\`\n---\n`;
            processedPrompt = processedPrompt.replace(`@${filePath}`, fileBlock);
        } catch { }
    }
    return processedPrompt;
}

function processSlashCommands(input: string, panel: vscode.WebviewPanel): string | null {
    const trimmed = input.trim().toLowerCase();

    if (trimmed === '/help') {
        return `📋 **Slash Commands:**
/help - This help
/clear - Clear history
/explain - Explain code
/fix - Fix bugs
/test - Generate tests
/refactor - Refactor code
/doc - Add documentation
/terminal <cmd> - Run terminal command
/search <query> - Search workspace
/voice - Voice input
/image - Image input
/settings - Configure settings
/multi - Multi-file edit`;
    }

    if (trimmed === '/clear') {
        vscode.commands.executeCommand('ai-code-assistant.clearHistory');
        return null;
    }
    if (trimmed === '/voice') {
        panel.webview.postMessage({ command: 'startVoiceRecognition' });
        return null;
    }
    if (trimmed === '/image') {
        panel.webview.postMessage({ command: 'promptForImage' });
        return null;
    }
    if (trimmed === '/settings') {
        vscode.commands.executeCommand('ai-code-assistant.configureSettings');
        return null;
    }
    if (trimmed === '/multi') {
        vscode.commands.executeCommand('ai-code-assistant.multiFileEdit');
        return null;
    }
    if (trimmed === '/explain') {
        return `Explain the selected code in detail.`;
    }
    if (trimmed === '/fix') {
        return `Fix any bugs or issues in this code. Return the complete fixed code.`;
    }
    if (trimmed === '/test') {
        return `Generate Playwright test cases for this code.`;
    }
    if (trimmed === '/refactor') {
        return `Refactor this code to be cleaner and more maintainable.`;
    }
    if (trimmed === '/doc') {
        return `Generate JSDoc documentation comments for this code.`;
    }
    if (trimmed.startsWith('/terminal ')) {
        const cmd = input.replace('/terminal', '').trim();
        if (cmd) { executeTerminalCommand(cmd, panel); }
        return null;
    }
    if (trimmed.startsWith('/search ')) {
        const query = input.replace('/search', '').trim();
        if (query) { searchWorkspace(query, panel); }
        return null;
    }

    if (settings.customInstructions) {
        return `${settings.customInstructions}\n\n${input}`;
    }
    return input;
}



function applyCodeToEditor(content: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor. Please open a file first.');
        return;
    }

    // Try to extract code from markdown code blocks
    const codeMatch = content.match(/```[\w]*\n([\s\S]*?)```/);

    // If code block found, use that; otherwise use the entire response
    let finalContent = codeMatch ? codeMatch[1] : content;

    // Optional: Clean up markdown formatting for text documents
    if (!codeMatch && (editor.document.languageId === 'markdown' || editor.document.fileName.endsWith('.md'))) {
        // For markdown files, keep the markdown formatting
        finalContent = content;
    }

    const selection = editor.selection;

    editor.edit(editBuilder => {
        if (selection && !selection.isEmpty) {
            editBuilder.replace(selection, finalContent);
        } else {
            editBuilder.insert(selection.active, finalContent);
        }
    }).then(success => {
        if (success) {
            vscode.window.showInformationMessage('Content applied to editor');
        }
    });
}

async function showMultiFilePreview(plan: MultiFileEdit) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const resolvedChanges: FileChange[] = [];

    for (const change of plan.changes) {
        const fullPath = path.isAbsolute(change.filePath) ? change.filePath : path.join(workspaceRoot, change.filePath);
        let originalContent = '';
        if (change.action !== 'create') {
            try {
                const content = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
                originalContent = Buffer.from(content).toString('utf8');
            } catch { }
        }
        resolvedChanges.push({ ...change, filePath: fullPath, originalContent });
    }

    const panel = vscode.window.createWebviewPanel('multiFilePreview', 'Multi-File Edit Preview', vscode.ViewColumn.Beside, { enableScripts: true });

    panel.webview.html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="padding:20px; font-family: var(--vscode-font-family);">
    <h2>Multi-File Edit Preview</h2>
    <p><strong>Summary:</strong> ${escapeHtml(plan.summary)}</p>
    <p><strong>${resolvedChanges.length} file change(s):</strong></p>
    ${resolvedChanges.map(c => `<div style="margin:10px 0; padding:10px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius:4px;">
        <b>${c.action.toUpperCase()}:</b> ${path.basename(c.filePath)}
        <div style="font-size:11px;">${c.filePath}</div>
    </div>`).join('')}
    <div style="margin-top:20px;">
        <button onclick="apply()">Apply Changes</button>
        <button onclick="cancel()">Cancel</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        function apply() { vscode.postMessage({ command: 'applyMultiFile', changes: ${JSON.stringify(resolvedChanges)} }); }
        function cancel() { vscode.postMessage({ command: 'cancel' }); }
    </script>
</body>
</html>`;

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'applyMultiFile') {
            lastMultiFileEdit = { summary: plan.summary, changes: message.changes };
            for (const change of message.changes) {
                const uri = vscode.Uri.file(change.filePath);
                if (change.action === 'create') {
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(change.newContent, 'utf8'));
                } else if (change.action === 'replace') {
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(change.newContent, 'utf8'));
                }
            }
            vscode.window.showInformationMessage('Multi-file edit applied');
            panel.dispose();
        } else if (message.command === 'cancel') {
            panel.dispose();
        }
    });
}

async function rollbackMultiFileEdit() {
    if (!lastMultiFileEdit) { return; }
    for (const change of lastMultiFileEdit.changes) {
        try {
            const uri = vscode.Uri.file(change.filePath);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(change.originalContent, 'utf8'));
        } catch { }
    }
}

function getWebviewContent(): string {
    const htmlPath = path.join(extensionContext!.extensionPath, 'out', 'webview.html');
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');
    return htmlContent;
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m] || m));
}

export function deactivate() { }