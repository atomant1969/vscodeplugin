// Example AI Assistant Plugin
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
                return `Current time: ${new Date().toLocaleTimeString()}`;
            }
        }
    ],
    onActivate: async () => {
        console.log('Example plugin activated');
    },
    onDeactivate: async () => {
        console.log('Example plugin deactivated');
    }
};