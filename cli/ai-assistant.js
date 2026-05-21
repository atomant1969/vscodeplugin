#!/usr/bin/env node

const https = require('https');
const http = require('http');
const readline = require('readline');

// Configuration
const SERVER_URL = process.env.AI_SERVER_URL || 'http://192.168.1.13:8001';
const USE_STREAMING = process.env.AI_STREAMING !== 'false';

// Parse command line arguments
const args = process.argv.slice(2);
const isInteractive = args.length === 0;
const prompt = args.join(' ');

function makeRequest(text, streaming) {
    return new Promise((resolve, reject) => {
        const url = new URL(`${SERVER_URL}/process${streaming ? '/stream' : ''}`);
        const data = JSON.stringify({
            prompt: text,
            task_type: 'chat'
        });
        
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };
        
        const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
            if (streaming) {
                res.on('data', (chunk) => {
                    process.stdout.write(chunk.toString());
                });
                res.on('end', () => {
                    console.log();
                    resolve();
                });
            } else {
                let responseData = '';
                res.on('data', (chunk) => { responseData += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(responseData);
                        console.log(parsed.result || parsed);
                        resolve();
                    } catch {
                        console.log(responseData);
                        resolve();
                    }
                });
            }
        });
        
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function interactiveMode() {
    console.log('🤖 AI Assistant CLI');
    console.log('Commands: /help, /clear, /exit');
    console.log('Type your prompt and press Enter.\n');
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    const ask = () => {
        rl.question('> ', async (input) => {
            if (input === '/exit' || input === '/quit') {
                console.log('Goodbye!');
                rl.close();
                return;
            }
            
            if (input === '/clear') {
                console.clear();
                ask();
                return;
            }
            
            if (input === '/help') {
                console.log('\nAvailable commands:');
                console.log('  /exit   - Exit the CLI');
                console.log('  /clear  - Clear screen');
                console.log('  /help   - Show this help');
                console.log('  /stream - Toggle streaming mode\n');
                ask();
                return;
            }
            
            if (input.trim()) {
                process.stdout.write('🤖 ');
                await makeRequest(input, USE_STREAMING);
                console.log();
            }
            ask();
        });
    };
    
    ask();
}

async function main() {
    if (isInteractive) {
        await interactiveMode();
    } else {
        await makeRequest(prompt, USE_STREAMING);
    }
}

main().catch(console.error);