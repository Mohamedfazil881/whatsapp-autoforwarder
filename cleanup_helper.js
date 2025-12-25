
// Force flush old config if it exists
try {
    const fs = require('fs');
    if (fs.existsSync('.wwebjs_auth')) {
        // fs.rmdirSync('.wwebjs_auth', { recursive: true });
    }
} catch (e) { }
