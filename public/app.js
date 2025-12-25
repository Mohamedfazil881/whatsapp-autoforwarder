const socket = io();

// State
let availableGroups = [];

// Elements
const statusBadge = document.getElementById('status-badge');
const qrContainer = document.getElementById('qr-container');
const qrImage = document.getElementById('qr-image');
const qrLoading = document.getElementById('qr-loading');
const qrText = document.getElementById('qr-text');
const connectionSection = document.getElementById('connection-section');
const dashboardSection = document.getElementById('dashboard-section');
const sourceSelect = document.getElementById('source-select');
const targetSelect = document.getElementById('target-select');
const rulesList = document.getElementById('rules-list');
const logsContainer = document.getElementById('logs-container');

// Socket Events
socket.on('status', (status) => {
    statusBadge.innerText = status;
    statusBadge.style.borderColor = status === 'Connected' ? '#10b981' : '#ef4444';

    if (status === 'Connected') {
        connectionSection.style.display = 'none';
        dashboardSection.style.display = 'block';
    } else if (status === 'Scan QR Code' || status.startsWith('Disconnected') || status.startsWith('Auth Failure')) {
        connectionSection.style.display = 'block';
        dashboardSection.style.display = 'none';

        // Reset QR if disconnected
        if (status.startsWith('Disconnected')) {
            qrImage.style.display = 'none';
            qrLoading.style.display = 'block';
            qrText.style.display = 'block';
            qrText.innerText = 'Disconnected. Restarting engine...';
        }
    }
});

socket.on('qr', (url) => {
    qrImage.src = url;
    qrImage.style.display = 'block';
    qrLoading.style.display = 'none';
    qrText.style.display = 'none';
});

socket.on('ready', () => {
    addLog('Client ready. Fetching groups...');
    reloadConfig();
});

socket.on('log', (msg) => {
    addLog(msg);
});

socket.on('groups', (groups) => {
    availableGroups = groups;
    populateSelects();
});

// Helper Functions
function addLog(msg) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logsContainer.prepend(div);
}

function populateSelects() {
    const opts = availableGroups.map(g => `<option value="${g.id}">${g.name}</option>`).join('');
    sourceSelect.innerHTML = '<option value="">Select Source Group</option>' + opts;
    targetSelect.innerHTML = '<option value="">Select Target Group</option>' + opts;
    // Re-render rules with names if possible
    reloadConfig();
}

function getGroupName(id) {
    const g = availableGroups.find(g => g.id === id);
    return g ? g.name : id.substring(0, 15) + '...';
}

function renderRules(rules) {
    rulesList.innerHTML = '';
    rules.forEach((rule, index) => {
        const sourceName = getGroupName(rule.source);
        // Supports multiple targets visually, though logic below might assume one for now
        // The server stores targets as array
        const targetsHtml = rule.targets.map(t => getGroupName(t)).join(', ');

        const div = document.createElement('div');
        div.className = 'rule-item';
        div.innerHTML = `
            <div class="rule-info">
                <strong>${sourceName}</strong> 
                <span class="arrow">➜</span> 
                <span>${targetsHtml}</span>
            </div>
            <button class="delete-btn" onclick="deleteRule(${index})">Remove</button>
        `;
        rulesList.appendChild(div);
    });
}

// API Interactions
async function reloadConfig() {
    try {
        const res = await fetch('/api/config');
        const data = await res.json();
        renderRules(data.rules || []);
    } catch (e) {
        console.error(e);
    }
}

document.getElementById('add-rule-btn').addEventListener('click', async () => {
    const source = sourceSelect.value;
    const target = targetSelect.value;

    if (!source || !target) {
        alert("Please select both a source and a target group.");
        return;
    }

    if (source === target) {
        alert("Source and Target cannot be the same.");
        return;
    }

    const newRule = {
        source: source,
        targets: [target] // currently UI only allows one at a time, but struct supports list
    };

    try {
        const res = await fetch('/api/config/rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newRule)
        });
        const data = await res.json();
        if (data.success) {
            renderRules(data.config.rules);
            addLog(`Rule added: ${getGroupName(source)} -> ${getGroupName(target)}`);
        }
    } catch (e) {
        console.error(e);
    }
});

document.getElementById('refresh-groups-btn').addEventListener('click', async () => {
    addLog('Refreshing groups...');
    try {
        const res = await fetch('/api/groups/refresh', { method: 'POST' });
        const data = await res.json();
        if (data.count) {
            addLog(`Found ${data.count} groups`);
        } else {
            addLog('Refresh request sent...');
        }
    } catch (e) {
        console.error(e);
        addLog('Error refreshing groups');
    }
});

window.deleteRule = async (index) => {
    if (!confirm('Delete this rule?')) return;
    try {
        const res = await fetch(`/api/config/rules/${index}`, {
            method: 'DELETE'
        });
        const data = await res.json();
        if (data.success) {
            renderRules(data.config.rules);
        }
    } catch (e) {
        console.error(e);
    }
};
