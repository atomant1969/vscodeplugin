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
        if (chatHistory.length > 100) chatHistory = chatHistory.slice(-100);
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

function registerCommands() {
    if (!extensionContext) return;

    // Add selected code to AI
    const addToAI = vscode.commands.registerCommand('ai-code-assistant.addToAI', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

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

    // Add entire file to AI
    const addFileToAI = vscode.commands.registerCommand('ai-code-assistant.addFileToAI', async (uri: vscode.Uri) => {
        if (!uri) return;
        
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
        
        if (!prUrl) return;
        
        vscode.window.showInformationMessage('🔍 Analyzing pull request...');
        
        try {
            const match = prUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
            if (!match) throw new Error('Invalid GitHub PR URL');
            
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
        
        if (!prUrl) return;
        
        const comment = await vscode.window.showInputBox({
            prompt: 'Enter your review comment',
            placeHolder: 'Comment to post on PR'
        });
        
        if (!comment) return;
        
        try {
            const match = prUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
            if (!match) throw new Error('Invalid URL');
            
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

        if (!prompt) return;

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
            if (!jsonMatch) throw new Error('Could not parse AI response');
            
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
        addToAI, addFileToAI, clearHistory, reviewPR, postPRComment,
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
                if (!code || code.length < 5) return [];
                
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
    if (!workspaceFolder) return;
    
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
    if (token) headers['Authorization'] = `Bearer ${token}`;
    
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
    if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
    return await response.text();
}

async function postGitHubPRComment(owner: string, repo: string, prNumber: string, comment: string): Promise<void> {
    const token = vscode.workspace.getConfiguration('ai-assistant').get<string>('githubToken');
    if (!token) throw new Error('GitHub token not configured');
    
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ body: comment })
    });
    if (!response.ok) throw new Error(`Failed to post comment: ${response.status}`);
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
        switch (message.command) {
            case 'sendPrompt':
                await handlePromptStreaming(message.prompt, panel);
                break;
            case 'retryPrompt':
                await handlePromptStreaming(message.prompt, panel);
                break;
            case 'applyCode':
                applyCodeToEditor(message.code);
                break;
            case 'copyCode':
                vscode.env.clipboard.writeText(message.code);
                vscode.window.showInformationMessage('Code copied');
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
            case 'clearHistory':
                chatHistory = [];
                saveHistory();
                panel.webview.postMessage({ command: 'historyCleared' });
                break;
            case 'sendVoiceInput':
                await handlePromptStreaming(message.text, panel);
                break;
            case 'sendImageInput':
                await handleImageInput(message.imageData, message.prompt, panel);
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
    if (!terminal) terminal = vscode.window.createTerminal('AI Assistant');
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
    if (!workspaceRoot) return prompt;
    
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
        if (cmd) executeTerminalCommand(cmd, panel);
        return null;
    }
    if (trimmed.startsWith('/search ')) {
        const query = input.replace('/search', '').trim();
        if (query) searchWorkspace(query, panel);
        return null;
    }
    
    if (settings.customInstructions) {
        return `${settings.customInstructions}\n\n${input}`;
    }
    return input;
}

async function handlePromptStreaming(prompt: string, panel: vscode.WebviewPanel) {
    const processed = processSlashCommands(prompt, panel);
    if (processed === null) return;
    
    const referencedPrompt = await processFileReferences(processed, panel);
    
    // CRITICAL: Null check for currentSelection
    if (!currentSelection) {
        panel.webview.postMessage({ 
            command: 'error', 
            error: 'No code selected. Please select some code first.' 
        });
        return;
    }
    
    addToHistory('user', referencedPrompt);
    panel.webview.postMessage({ command: 'thinking', thinking: true });
    panel.webview.postMessage({ command: 'clearResponse', clear: true });

    const fullPrompt = `Context: ${currentSelection.lineStart === 1 && currentSelection.lineEnd === currentSelection.code.split('\n').length ? 'Full file' : `Lines ${currentSelection.lineStart}-${currentSelection.lineEnd}`} from ${currentSelection.filePath.split(/[\\/]/).pop()}

Code:
\`\`\`
${currentSelection.code}
\`\`\`

Instruction: ${referencedPrompt}

Respond with markdown. Show complete modified code blocks.`;

    try {
        const response = await fetch(`${getServerUrl()}/process/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: fullPrompt, task_type: 'chat' })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let accumulated = '';

        while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            accumulated += chunk;
            panel.webview.postMessage({ command: 'streamChunk', chunk: chunk, full: accumulated });
        }
        
        addToHistory('assistant', accumulated);
        panel.webview.postMessage({ command: 'streamComplete', response: accumulated });
        
    } catch (error: any) {
        panel.webview.postMessage({ 
            command: 'errorWithRetry', 
            error: error.message, 
            originalPrompt: prompt 
        });
    } finally {
        panel.webview.postMessage({ command: 'thinking', thinking: false });
    }
}

function applyCodeToEditor(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
    }
    
    // CRITICAL: Null check for currentSelection
    if (!currentSelection) {
        vscode.window.showErrorMessage('No code selected to apply changes to');
        return;
    }
    
    const codeMatch = code.match(/```[\w]*\n([\s\S]*?)```/);
    const finalCode = codeMatch ? codeMatch[1] : code;
    
    editor.edit(editBuilder => {
        const startLine = currentSelection.lineStart - 1;
        const endLine = currentSelection.lineEnd - 1;
        
        if (endLine >= editor.document.lineCount) {
            vscode.window.showErrorMessage('Selected line range is outside document bounds');
            return;
        }
        
        const range = new vscode.Range(
            startLine, 0,
            endLine, editor.document.lineAt(endLine).text.length
        );
        editBuilder.replace(range, finalCode);
    });
    vscode.window.showInformationMessage('Code applied to editor');
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
    if (!lastMultiFileEdit) return;
    for (const change of lastMultiFileEdit.changes) {
        try {
            const uri = vscode.Uri.file(change.filePath);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(change.originalContent, 'utf8'));
        } catch { }
    }
}

function getWebviewContent(): string {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { padding: 12px; font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
        .selection-info { background: var(--vscode-editor-selectionBackground); padding: 8px; border-radius: 4px; margin-bottom: 12px; font-size: 12px; }
        .selection-info code { display: block; white-space: pre-wrap; font-size: 11px; margin-top: 8px; padding: 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 3px; max-height: 150px; overflow: auto; }
        .history-section { margin-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; }
        .history-header { font-weight: bold; margin-bottom: 8px; cursor: pointer; }
        .history-messages { max-height: 120px; overflow-y: auto; margin-bottom: 12px; font-size: 11px; }
        .history-message { padding: 4px; margin-bottom: 4px; border-radius: 4px; }
        .history-message.user { background: var(--vscode-editor-selectionBackground); }
        .history-message.assistant { background: var(--vscode-editor-inactiveSelectionBackground); }
        .toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
        .toolbar button { padding: 4px 8px; font-size: 11px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; }
        .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
        .search-area { display: flex; gap: 8px; margin-bottom: 12px; }
        .search-area input { flex: 1; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
        textarea { width: 100%; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; resize: vertical; font-family: inherit; }
        button { margin-top: 8px; padding: 6px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; }
        .response-content { background: var(--vscode-editor-inactiveSelectionBackground); padding: 10px; border-radius: 4px; margin-top: 8px; max-height: 350px; overflow-y: auto; font-size: 12px; }
        .response-content pre { background: var(--vscode-editor-background); padding: 8px; border-radius: 4px; overflow-x: auto; }
        .code-actions { margin-top: 8px; display: flex; gap: 8px; }
        .thinking { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); padding: 8px; }
        .loading-spinner { width: 16px; height: 16px; border: 2px solid var(--vscode-foreground); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .error { color: var(--vscode-errorForeground); margin-top: 8px; padding: 8px; background: var(--vscode-inputValidation-errorBackground); border-radius: 4px; }
        .streaming-cursor { display: inline-block; width: 2px; height: 14px; background: var(--vscode-foreground); animation: blink 1s step-end infinite; vertical-align: middle; margin-left: 2px; }
        @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
        kbd { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 2px 6px; font-family: monospace; font-size: 10px; }
        details { margin-bottom: 12px; }
        summary { cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 11px; }
    </style>
</head>
<body>
    <div id="selectionInfo" class="selection-info" style="display: none;">
        <strong>📌 Selected</strong>
        <div id="fileInfo"></div>
        <code id="selectedCode"></code>
    </div>

    <details>
        <summary>⌨️ Keyboard Shortcuts</summary>
        <div style="padding: 8px; font-size: 11px;">
            <div><kbd>Ctrl+Shift+F</kbd> - Fix code</div>
            <div><kbd>Ctrl+Shift+G</kbd> - Generate code</div>
            <div><kbd>Ctrl+Shift+E</kbd> - Explain code</div>
            <div><kbd>Ctrl+Shift+T</kbd> - Generate test</div>
            <div><kbd>Ctrl+Enter</kbd> - Send prompt</div>
            <div><kbd>/help</kbd> - All slash commands</div>
        </div>
    </details>

    <div class="history-section">
        <div class="history-header" onclick="toggleHistory()">📜 History ▼</div>
        <div id="historyMessages" class="history-messages"></div>
    </div>

    <div class="toolbar">
        <button id="voiceBtn">🎤 Voice</button>
        <button id="imageBtn">🖼️ Image</button>
        <button id="settingsBtn">⚙️ Settings</button>
        <button id="exportBtn">💾 Export</button>
        <button id="importBtn">📂 Import</button>
    </div>

    <div class="search-area">
        <input type="text" id="searchInput" placeholder="🔍 Search workspace...">
        <button id="searchBtn">Search</button>
    </div>

    <div id="searchResults" style="display: none;"></div>
    <div id="systemMessages"></div>

    <textarea id="promptInput" rows="3" placeholder="Ask AI... Type /help for commands"></textarea>
    <button id="sendBtn">Send</button>
    <div style="font-size: 10px; margin-top: 4px;">💡 /help, /voice, /image, @file.ts, Ctrl+Enter to send</div>

    <div id="responseArea" style="display: none;">
        <div class="response-header">🤖 Response <span id="streamingIndicator" class="streaming-cursor"></span></div>
        <div class="response-content" id="responseContent"></div>
        <div class="code-actions" id="codeActions" style="display: none;">
            <button id="applyBtn">Apply</button>
            <button id="copyBtn">Copy</button>
        </div>
    </div>

    <div id="thinking" class="thinking" style="display: none;">
        <div class="loading-spinner"></div>
        <span>AI is thinking...</span>
    </div>
    <div id="errorMsg" class="error" style="display: none;"></div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentResponse = '';
        let recognition = null;

        if ('webkitSpeechRecognition' in window) {
            recognition = new webkitSpeechRecognition();
            recognition.continuous = false;
            recognition.interimResults = false;
            recognition.onresult = (e) => {
                const text = e.results[0][0].transcript;
                document.getElementById('promptInput').value = text;
                vscode.postMessage({ command: 'sendVoiceInput', text: text });
            };
        }

        function toggleHistory() {
            const msgs = document.getElementById('historyMessages');
            const header = document.querySelector('.history-header');
            if (msgs.style.display === 'none') {
                msgs.style.display = 'block';
                header.innerHTML = '📜 History ▼';
            } else {
                msgs.style.display = 'none';
                header.innerHTML = '📜 History ▶';
            }
        }

        document.getElementById('voiceBtn').onclick = () => {
            if (recognition) recognition.start();
            else showError('Voice not supported');
        };

        document.getElementById('imageBtn').onclick = () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.onchange = (e) => {
                const file = e.target.files[0];
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const prompt = document.getElementById('promptInput').value || 'Analyze this image';
                    vscode.postMessage({ command: 'sendImageInput', imageData: ev.target.result, prompt: prompt });
                };
                reader.readAsDataURL(file);
            };
            input.click();
        };

        document.getElementById('settingsBtn').onclick = () => vscode.postMessage({ command: 'sendPrompt', prompt: '/settings' });
        document.getElementById('exportBtn').onclick = () => vscode.postMessage({ command: 'exportHistory' });
        document.getElementById('importBtn').onclick = () => vscode.postMessage({ command: 'importHistory' });
        document.getElementById('sendBtn').onclick = () => {
            const prompt = document.getElementById('promptInput').value.trim();
            if (prompt) {
                vscode.postMessage({ command: 'sendPrompt', prompt: prompt });
                document.getElementById('promptInput').value = '';
            }
        };
        document.getElementById('promptInput').addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') document.getElementById('sendBtn').click();
        });
        document.getElementById('searchBtn').onclick = () => {
            const query = document.getElementById('searchInput').value.trim();
            if (query) vscode.postMessage({ command: 'searchWorkspace', query: query });
        };

        window.addEventListener('message', (event) => {
            const msg = event.data;
            switch (msg.command) {
                case 'selectionLoaded':
                    document.getElementById('selectionInfo').style.display = 'block';
                    document.getElementById('fileInfo').innerHTML = \`📄 \${msg.fileName} L\${msg.lineStart}-\${msg.lineEnd}\`;
                    document.getElementById('selectedCode').textContent = msg.code;
                    break;
                case 'updateHistory':
                    const historyDiv = document.getElementById('historyMessages');
                    if (msg.history && msg.history.length) {
                        historyDiv.innerHTML = msg.history.map(h => \`<div class="history-message \${h.role}"><strong>\${h.role === 'user' ? 'You' : 'AI'}:</strong> \${escapeHtml(h.content)}</div>\`).join('');
                    } else {
                        historyDiv.innerHTML = '<div class="system-message">No history yet</div>';
                    }
                    break;
                case 'appendSystemMessage':
                    const sysDiv = document.createElement('div');
                    sysDiv.className = 'system-message';
                    sysDiv.textContent = msg.message;
                    document.getElementById('systemMessages').appendChild(sysDiv);
                    setTimeout(() => sysDiv.remove(), 3000);
                    break;
                case 'searchResults':
                    const resultsDiv = document.getElementById('searchResults');
                    if (msg.results && msg.results.length) {
                        resultsDiv.innerHTML = \`<strong>🔍 \${msg.count} matches</strong><ul>\${msg.results.map(r => \`<li onclick="vscode.postMessage({ command: 'openFile', path: '\${r.path}:\${r.line}' })">📄 \${r.name} L\${r.line}<div style="font-size:10px;">\${escapeHtml(r.preview)}</div></li>\`).join('')}</ul>\`;
                    } else {
                        resultsDiv.innerHTML = '<div class="system-message">No results found</div>';
                    }
                    resultsDiv.style.display = 'block';
                    break;
                case 'clearHistory':
                    document.getElementById('historyMessages').innerHTML = '<div class="system-message">History cleared</div>';
                    break;
                case 'thinking':
                    document.getElementById('thinking').style.display = msg.thinking ? 'flex' : 'none';
                    break;
                case 'clearResponse':
                    currentResponse = '';
                    document.getElementById('responseContent').innerHTML = '';
                    document.getElementById('codeActions').style.display = 'none';
                    document.getElementById('streamingIndicator').style.display = 'inline-block';
                    document.getElementById('responseArea').style.display = 'block';
                    break;
                case 'streamChunk':
                    currentResponse = msg.full;
                    const responseDiv = document.getElementById('responseContent');
                    responseDiv.innerHTML = marked.parse(msg.full);
                    responseDiv.scrollTop = responseDiv.scrollHeight;
                    break;
                case 'streamComplete':
                    document.getElementById('streamingIndicator').style.display = 'none';
                    document.getElementById('codeActions').style.display = 'block';
                    break;
                case 'response':
                    currentResponse = msg.response;
                    document.getElementById('responseContent').innerHTML = marked.parse(msg.response);
                    document.getElementById('responseArea').style.display = 'block';
                    document.getElementById('codeActions').style.display = 'block';
                    break;
                case 'errorWithRetry':
                    showError(msg.error, () => {
                        vscode.postMessage({ command: 'retryPrompt', prompt: msg.originalPrompt });
                    });
                    break;
                case 'error':
                    showError(msg.error);
                    break;
            }
        });

        document.getElementById('applyBtn').onclick = () => vscode.postMessage({ command: 'applyCode', code: currentResponse });
        document.getElementById('copyBtn').onclick = () => vscode.postMessage({ command: 'copyCode', code: currentResponse });

        function showError(msg, retryFn) {
            const errDiv = document.getElementById('errorMsg');
            errDiv.innerHTML = \`<div>❌ \${escapeHtml(msg)}</div>\${retryFn ? '<button onclick="window.retryCallback()">⟳ Retry</button>' : ''}\`;
            errDiv.style.display = 'block';
            if (retryFn) window.retryCallback = retryFn;
            setTimeout(() => errDiv.style.display = 'none', 8000);
        }

        function escapeHtml(text) { return text.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }
    </script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m] || m));
}

export function deactivate() {}