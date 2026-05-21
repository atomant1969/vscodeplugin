# 🤖 AI Code Assistant

A powerful, local-first AI coding assistant for VS Code. Connect to your own AI server running on Ubuntu (or any machine with Ollama + InferAll) and get intelligent code help without sending your code to the cloud.

## Features

### Core Functionality

| Feature | Description |
|---------|-------------|
| **Add to AI** | Select code, right-click, and send to AI sidebar |
| **File Context** | Right-click any file in explorer to load entire file |
| **@ File References** | Type `@path/to/file.ts` in prompts to include files |
| **Slash Commands** | Type `/help` to see all commands |
| **Voice Input** | Speak your prompts (uses Web Speech API) |
| **Image Input** | Upload screenshots for AI to analyze |

### AI Capabilities

| Command | What it does |
|---------|--------------|
| `/fix` | Fix bugs and syntax errors |
| `/explain` | Explain code in detail |
| `/test` | Generate Playwright unit tests |
| `/refactor` | Refactor code for better structure |
| `/doc` | Generate JSDoc documentation |
| `/search <query>` | Search workspace for text |
| `/terminal <cmd>` | Execute terminal commands |
| `/multi` | Multi-file editing across project |

### IDE Integration

- **Lightbulb (Code Actions)** - Quick access to AI from editor
- **Status Bar** - Shows connection status to AI server
- **Jupyter Notebooks** - Automatic detection and support
- **Keyboard Shortcuts** - Ctrl+Shift+F/G/E/T

### Advanced Features

| Feature | Description |
|---------|-------------|
| **Multi-File Editing** | AI can modify multiple files in one operation with preview and rollback |
| **PR Review** | Analyze GitHub pull requests and post comments |
| **Pre-commit Hooks** | Automatic setup of git hooks for code quality |
| **Workspace Search** | Search entire codebase for patterns |
| **Conversation History** | Persistent chat history, import/export |
| **Custom Instructions** | Set personal AI preferences |

## Installation

### 1. Install the Extension

**Option A: VSIX File**
```bash
# Copy the .vsix file to your machine
# In VS Code: Extensions (Ctrl+Shift+X) → ... → Install from VSIX