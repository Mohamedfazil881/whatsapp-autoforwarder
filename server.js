const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const CONFIG_FILE = path.join(__dirname, 'config.json');

// Middleware
app.use(express.static('public'));
app.use(express.json());

// Load or create config
let config = {
    rules: [] // { source: 'groupId', targets: ['groupId1', 'groupId2'], types: ['image', 'audio', 'document', 'text'] }
};

if (fs.existsSync(CONFIG_FILE)) {
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE));
    } catch (e) {
        console.error("Error reading config", e);
    }
} else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: fs.existsSync('/usr/bin/google-chrome-stable') ? '/usr/bin/google-chrome-stable' : (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-extensions'
        ]
    }
});

// State tracking
let currentStatus = 'Initializing...';
let availableGroups = [];

io.on('connection', (socket) => {
    socket.emit('status', currentStatus);
    socket.emit('groups', availableGroups);
    if (availableGroups.length > 0) {
        socket.emit('log', `Syncing ${availableGroups.length} groups...`);
    }
});

// Connection Logic
let isReconnecting = false;

const updateStatus = (status) => {
    currentStatus = status;
    io.emit('status', status);
};

const initializeClient = async () => {
    updateStatus('Initializing...');
    io.emit('log', 'Launching WhatsApp Engine... (Please wait for Chrome Window)');
    try {
        await client.initialize();
    } catch (e) {
        console.error('Initialization error:', e);
        updateStatus('Init Error');

        // AUTO-FIX for "Execution context destroyed" or Session Corruption
        const errorMsg = e.message || '';
        if (errorMsg.includes('Execution context was destroyed') ||
            errorMsg.includes('Protocol error') ||
            errorMsg.includes('Evaluation failed')) {

            io.emit('log', 'CRITICAL ERROR: Session corrupted. Performing auto-cleanup...');
            console.log('Detected fatal error. Cleaning up session data...');

            // Attempt to destroy client to release locks
            try { await client.destroy(); } catch (err) { }

            // Delete session files
            const authPath = path.join(__dirname, '.wwebjs_auth');
            const cachePath = path.join(__dirname, '.wwebjs_cache');

            setTimeout(() => {
                try {
                    // Using recursive delete
                    if (fs.existsSync(authPath)) {
                        fs.rmSync(authPath, { recursive: true, force: true });
                        console.log('Deleted .wwebjs_auth');
                    }
                    if (fs.existsSync(cachePath)) {
                        fs.rmSync(cachePath, { recursive: true, force: true });
                        console.log('Deleted .wwebjs_cache');
                    }
                    io.emit('log', 'Session reset. Restarting in 3s...');
                } catch (rmErr) {
                    console.error('Failed to cleanup session files:', rmErr);
                    io.emit('log', 'Auto-cleanup failed. Please run fix_connection.bat manually.');
                }

                setTimeout(initializeClient, 3000);
            }, 1000);
            return;
        }

        io.emit('log', 'Initialization failed. Retrying in 5s...');
        setTimeout(initializeClient, 5000);
    }
};

client.on('qr', (qr) => {
    console.log('QR Code received');
    qrcode.toDataURL(qr, (err, url) => {
        if (!err) {
            io.emit('qr', url);
            updateStatus('Scan QR Code');
            io.emit('log', 'Please scan the new QR Code');
        }
    });
});

client.on('ready', async () => {
    console.log('Client is ready!');
    updateStatus('Connected');
    io.emit('ready');
    isReconnecting = false;

    io.emit('log', 'Fetching groups... (This can take 30s for new logins)');

    // Robust Fetching Loop
    let attempts = 0;
    const fetchGroups = async () => {
        attempts++;
        try {
            console.log(`Fetching chats (Attempt ${attempts})...`);
            const chats = await client.getChats();
            const groups = chats
                .filter(chat => chat.isGroup)
                .map(chat => ({ id: chat.id._serialized, name: chat.name }));

            if (groups.length > 0) {
                availableGroups = groups;
                io.emit('groups', availableGroups);
                io.emit('log', `Success: Loaded ${availableGroups.length} groups.`);
                // If we found groups, we can stop aggressive fetching, but maybe check once more later
                if (attempts < 5) setTimeout(fetchGroups, 5000);
            } else {
                io.emit('log', `Syncing... Scanned ${chats.length} chats so far (Waiting for groups)`);
                if (attempts < 20) { // Try for ~2 minutes
                    setTimeout(fetchGroups, 5000);
                } else {
                    io.emit('log', 'Could not find groups automatically. Please click "Refresh Groups" manually.');
                }
            }
        } catch (e) {
            console.error("Error fetching chats", e);
            io.emit('log', 'Error reading chats. Retrying...');
            if (attempts < 20) setTimeout(fetchGroups, 5000);
        }
    };

    fetchGroups();
});

client.on('authenticated', () => {
    console.log('Authenticated successfully');
    updateStatus('Authenticated');
    io.emit('log', 'Authentication successful, waiting for ready...');
});

client.on('auth_failure', msg => {
    console.error('Authentication failure:', msg);
    updateStatus('Auth Failure');
    io.emit('log', 'Authentication failed: ' + msg);
});

client.on('disconnected', async (reason) => {
    console.log('Client disconnected:', reason);
    updateStatus('Disconnected');
    io.emit('log', `Disconnected (${reason}). Reconnecting...`);

    if (!isReconnecting) {
        isReconnecting = true;
        // Destroy and re-init
        try {
            await client.destroy();
        } catch (e) { console.error('Error destroyed client', e); }

        setTimeout(initializeClient, 3000);
    }
});

// Message Handling
client.on('message_create', async msg => {
    try {
        const chat = await msg.getChat();

        // We only care about groups
        if (!chat.isGroup) return;

        // DEBUG LOG: Show everything received to confirm connection
        console.log(`DEBUG: Msg in ${chat.name} (${msg.type})`);
        io.emit('log', `DEBUG: Saw ${msg.type} in ${chat.name}`);

        // Check if this group is a source in any rule
        const validRules = config.rules.filter(r => r.source === chat.id._serialized);

        if (validRules.length > 0) {
            const type = msg.type; // chat, image, audio, ptt, document, etc.

            console.log(`Detected msg in Source Group: ${chat.name} [Type: ${type}]`);

            // Check MIME type for documents to see if they are actually videos/images sent as files
            let isMedia = ['image', 'video', 'gif'].includes(type);
            let mime = msg._data.mimetype || '';

            if (type === 'document') {
                if (mime.startsWith('image/') || mime.startsWith('video/')) {
                    isMedia = true;
                    console.log(`Document identified as media: ${mime}`);
                }
            }

            if (isMedia) {
                // deep logging
                io.emit('log', `Detected ${type.toUpperCase()} (${mime}) in ${chat.name}`);

                for (const rule of validRules) {
                    for (const targetId of rule.targets) {
                        if (targetId === chat.id._serialized) continue;

                        try {
                            io.emit('log', `--> Processing ${type} for target...`);
                            console.log(`Starting media process for msg: ${msg.id._serialized}`);

                            let sentAsMedia = false;

                            // 1. Try to download, Save to Disk, and Send (Most Reliable for Videos)
                            if (msg.hasMedia) {
                                try {
                                    io.emit('log', `Downloading media content...`);
                                    const media = await msg.downloadMedia();

                                    if (media && media.data) {
                                        const mime = media.mimetype || 'application/octet-stream';

                                        // Robust Extension Mapping for WhatsApp
                                        const mimeMap = {
                                            'video/mp4': 'mp4',
                                            'video/3gpp': '3gp',
                                            'video/quicktime': 'mov',
                                            'video/x-matroska': 'mkv',
                                            'image/jpeg': 'jpg',
                                            'image/png': 'png',
                                            'image/webp': 'webp',
                                            'image/gif': 'gif',
                                            'audio/ogg': 'ogg',
                                            'audio/mp4': 'm4a',
                                            'audio/mpeg': 'mp3'
                                        };

                                        let ext = mimeMap[mime.split(';')[0]] || mime.split('/')[1].split(';')[0] || 'bin';
                                        const filename = `temp_${Date.now()}.${ext}`;

                                        const publicDir = path.join(__dirname, 'public');
                                        if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

                                        const filePath = path.join(publicDir, filename);

                                        // Write file
                                        fs.writeFileSync(filePath, media.data, 'base64');

                                        // LOG DETAILS
                                        const stats = fs.statSync(filePath);
                                        console.log(`Saved ${filename} (${stats.size} bytes). Mime: ${mime}`);

                                        if (stats.size === 0) {
                                            throw new Error("File empty after write");
                                        }

                                        const mediaFromFile = MessageMedia.fromFilePath(filePath);

                                        // FORCE MIME AND FILENAME (Crucial for playback)
                                        mediaFromFile.mimetype = mime;
                                        mediaFromFile.filename = filename;

                                        const sendOptions = {
                                            caption: msg.body || '',
                                            sendAudioAsVoice: type === 'ptt' || type === 'audio',
                                            sendMediaAsDocument: false
                                        };

                                        io.emit('log', `Media cached locally (${(stats.size / 1024 / 1024).toFixed(2)} MB). Sending...`);

                                        await client.sendMessage(targetId, mediaFromFile, sendOptions);
                                        sentAsMedia = true;
                                        io.emit('log', `--> Sent as Native Media ✅`);

                                        // Cleanup
                                        setTimeout(() => {
                                            try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { }
                                        }, 30000); // 30s cleanup
                                    } else {
                                        console.error("Download returned undefined/null data");
                                        io.emit('log', `Download failed (Data unavailable).`);
                                    }
                                } catch (downloadErr) {
                                    console.error("Download/Send Error:", downloadErr);
                                    io.emit('log', `Native Send failed: ${downloadErr.message}. Trying forward...`);
                                }
                            }

                            // 2. Fallback to Forward (If download failed or not media)
                            if (!sentAsMedia) {
                                io.emit('log', `Switching to Fallback Forward...`);
                                await msg.forward(targetId);
                                io.emit('log', `--> Forwarded (Fallback) ✅`);
                            }

                        } catch (e) {
                            console.error("Transmission error", e);
                            io.emit('log', `!! Error sending ${type}: ${e.message}`);
                        }
                    }
                }
            } else {
                console.log(`Skipping type: ${type} (Mime: ${mime})`);
                // Explicitly tell user on UI why it was skipped
                if (type === 'chat') {
                    // io.emit('log', `Ignored Text Message (Only Images/Videos allowed) 🚫`);
                } else {
                    io.emit('log', `Skipped ${type} (Not an image/video) 🚫`);
                }
            }
        }
    } catch (error) {
        console.error("Error processing message:", error);
    }
});

initializeClient();

// API
app.get('/api/groups', (req, res) => {
    res.json(availableGroups);
});

app.get('/api/config', (req, res) => {
    res.json(config);
});

app.post('/api/config/rules', (req, res) => {
    const newRule = req.body;
    // validation could be added here
    config.rules.push(newRule);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    res.json({ success: true, config });
});

app.delete('/api/config/rules/:index', (req, res) => {
    const index = parseInt(req.params.index);
    if (index >= 0 && index < config.rules.length) {
        config.rules.splice(index, 1);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        res.json({ success: true, config });
    } else {
        res.status(400).json({ error: 'Invalid index' });
    }
});

app.post('/api/groups/refresh', async (req, res) => {
    if (client && client.info) { // checks if connected
        try {
            console.log('Manual group refresh requested');
            const chats = await client.getChats();
            availableGroups = chats
                .filter(chat => chat.isGroup)
                .map(chat => ({ id: chat.id._serialized, name: chat.name }));
            io.emit('groups', availableGroups);
            res.json({ success: true, count: availableGroups.length });
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: e.message });
        }
    } else {
        res.json({ success: false, message: 'Client not ready' });
    }
});

const PORT = 3001;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
