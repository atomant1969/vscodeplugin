import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface AICommand {
    name: string;
    handler: (args: any) => Promise<string>;
    description?: string;
}

export interface AIPlugin {
    name: string;
    version: string;
    commands?: AICommand[];
    onActivate?: () => Promise<void>;
    onDeactivate?: () => Promise<void>;
}

class PluginManager {
    private plugins: Map<string, AIPlugin> = new Map();
    private commands: Map<string, AICommand> = new Map();
    
    async loadPlugins(context: vscode.ExtensionContext) {
        const pluginsPath = path.join(context.extensionPath, 'plugins');
        
        if (!fs.existsSync(pluginsPath)) {
            fs.mkdirSync(pluginsPath, { recursive: true });
            this.createExamplePlugin(pluginsPath);
        }
        
        const pluginFolders = fs.readdirSync(pluginsPath);
        
        for (const folder of pluginFolders) {
            const pluginPath = path.join(pluginsPath, folder);
            const packagePath = path.join(pluginPath, 'package.json');
            
            if (fs.existsSync(packagePath)) {
                try {
                    const pluginConfig = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
                    const mainPath = path.join(pluginPath, pluginConfig.main || 'index.js');
                    
                    if (fs.existsSync(mainPath)) {
                        const plugin = require(mainPath);
                        this.plugins.set(plugin.name, plugin);
                        
                        if (plugin.onActivate) {
                            await plugin.onActivate();
                        }
                        
                        if (plugin.commands) {
                            for (const cmd of plugin.commands) {
                                this.commands.set(cmd.name, cmd);
                                const disposable = vscode.commands.registerCommand(
                                    `ai-assistant.plugin.${plugin.name}.${cmd.name}`,
                                    async () => {
                                        const result = await cmd.handler({});
                                        vscode.window.showInformationMessage(result);
                                    }
                                );
                                context.subscriptions.push(disposable);
                            }
                        }
                        
                        console.log(`Loaded plugin: ${plugin.name} v${plugin.version}`);
                    }
                } catch (error) {
                    console.error(`Failed to load plugin ${folder}:`, error);
                }
            }
        }
    }
    
    private createExamplePlugin(pluginsPath: string) {
        const examplePath = path.join(pluginsPath, 'example-plugin');
        fs.mkdirSync(examplePath, { recursive: true });
        
        const packageJson = {
            name: 'example-plugin',
            version: '1.0.0',
            main: 'index.js'
        };
        
        const indexJs = `// Example AI Assistant Plugin
module.exports = {
    name: 'example-plugin',
    version: '1.0.0',
    commands: [
        {
            name: 'hello',
            description: 'Say hello',
            handler: async (args) => {
                return 'Hello from the example plugin!';
            }
        },
        {
            name: 'time',
            description: 'Get current time',
            handler: async (args) => {
                return \`Current time: \${new Date().toLocaleTimeString()}\`;
            }
        }
    ],
    onActivate: async () => {
        console.log('Example plugin activated');
    },
    onDeactivate: async () => {
        console.log('Example plugin deactivated');
    }
};`;
        
        fs.writeFileSync(path.join(examplePath, 'package.json'), JSON.stringify(packageJson, null, 2));
        fs.writeFileSync(path.join(examplePath, 'index.js'), indexJs);
    }
    
    async executeCommand(commandName: string, args: any): Promise<string | null> {
        const cmd = this.commands.get(commandName);
        if (cmd) {
            return await cmd.handler(args);
        }
        return null;
    }
    
    getCommands(): string[] {
        return Array.from(this.commands.keys());
    }
}

export const pluginManager = new PluginManager();