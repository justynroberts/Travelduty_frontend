// Git Deploy Scheduler - Frontend JavaScript

const API_BASE = '';
let refreshInterval = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    console.log('Git Deploy Scheduler UI Loaded');
    loadData();
    startAutoRefresh();
});

// Auto refresh every 5 seconds
function startAutoRefresh() {
    refreshInterval = setInterval(() => {
        loadData();
    }, 5000);
}

// Load all data
async function loadData() {
    try {
        await Promise.all([
            loadStatus(),
            loadHistory(),
            loadStats()
        ]);
    } catch (error) {
        console.error('Error loading data:', error);
    }
}

// Load status
async function loadStatus() {
    try {
        const response = await fetch(`${API_BASE}/api/status`);
        const data = await response.json();

        // Update status badge
        const badge = document.getElementById('statusBadge');
        const statusText = document.getElementById('statusText');

        if (data.paused) {
            badge.className = 'status-badge paused';
            statusText.textContent = 'Paused';
            document.getElementById('pauseBtn').style.display = 'none';
            document.getElementById('resumeBtn').style.display = 'inline-flex';
        } else {
            badge.className = 'status-badge running';
            statusText.textContent = 'Running';
            document.getElementById('pauseBtn').style.display = 'inline-flex';
            document.getElementById('resumeBtn').style.display = 'none';
        }

        // Update next commit countdown
        if (data.next_commit_in !== null && data.next_commit_in !== undefined) {
            const minutes = Math.floor(data.next_commit_in / 60);
            const seconds = Math.floor(data.next_commit_in % 60);
            document.getElementById('nextCommit').textContent =
                `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
        } else {
            document.getElementById('nextCommit').textContent = '--:--';
        }

        // Update theme
        const theme = data.current_theme || 'No theme';
        document.getElementById('currentTheme').textContent = theme;
        document.getElementById('currentTheme').title = theme;

        // Update Ollama status
        const ollamaEl = document.getElementById('ollamaStatus');
        if (data.ollama_available) {
            ollamaEl.textContent = 'Available';
            ollamaEl.className = 'value success';
        } else {
            ollamaEl.textContent = 'Unavailable';
            ollamaEl.className = 'value error';
        }

        // Update repo info
        if (data.repository) {
            const repoName = data.repository.split('/').pop();
            document.getElementById('repoPath').textContent = repoName;
            document.getElementById('repoBranch').textContent = data.branch || 'main';
        }

    } catch (error) {
        console.error('Error loading status:', error);
    }
}

// Load history
async function loadHistory() {
    try {
        const response = await fetch(`${API_BASE}/api/history?limit=20`);
        const data = await response.json();

        const commitList = document.getElementById('commitList');
        const commitCount = document.getElementById('commitCount');

        commitCount.textContent = data.total;

        if (!data.commits || data.commits.length === 0) {
            commitList.innerHTML = `
                <div class="empty-state">
                    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="4"></circle>
                        <line x1="1.05" y1="12" x2="7" y2="12"></line>
                        <line x1="17.01" y1="12" x2="22.96" y2="12"></line>
                    </svg>
                    <div>No commits yet</div>
                    <div style="font-size: 12px; margin-top: 8px;">Waiting for first scheduled commit...</div>
                </div>
            `;
            return;
        }

        commitList.innerHTML = data.commits.map(commit => {
            const type = extractCommitType(commit.message);
            const timeAgo = formatTimeAgo(commit.timestamp);
            const icon = getCommitIcon(commit.success, commit.used_ollama);

            return `
                <div class="commit-item">
                    <div class="commit-message">
                        ${icon}
                        <span class="badge ${type}">${type}</span>
                        <span>${escapeHtml(commit.message)}</span>
                    </div>
                    <div class="commit-meta">
                        <span>
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="10"></circle>
                                <polyline points="12 6 12 12 16 14"></polyline>
                            </svg>
                            ${timeAgo}
                        </span>
                        <span>
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                                <polyline points="13 2 13 9 20 9"></polyline>
                            </svg>
                            ${commit.files_changed} file${commit.files_changed !== 1 ? 's' : ''}
                        </span>
                        <span>
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="4"></circle>
                                <line x1="1.05" y1="12" x2="7" y2="12"></line>
                                <line x1="17.01" y1="12" x2="22.96" y2="12"></line>
                            </svg>
                            ${commit.hash.substring(0, 7)}
                        </span>
                    </div>
                </div>
            `;
        }).join('');

    } catch (error) {
        console.error('Error loading history:', error);
        document.getElementById('commitList').innerHTML = `
            <div class="empty-state">
                <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
                <div>Error loading commits</div>
            </div>
        `;
    }
}

// Load stats
async function loadStats() {
    try {
        const response = await fetch(`${API_BASE}/api/stats`);
        const data = await response.json();

        document.getElementById('totalCommits').textContent = data.total_commits;
        document.getElementById('successRate').textContent = `${Math.round(data.success_rate)}%`;
        document.getElementById('aiUsage').textContent = `${Math.round(data.ollama_usage_rate)}%`;
        document.getElementById('commits24h').textContent = data.commits_last_24h;

    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// Control functions
async function pauseScheduler() {
    try {
        const response = await fetch(`${API_BASE}/api/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'pause' })
        });

        if (response.ok) {
            showNotification('Scheduler paused', 'success');
            loadStatus();
        }
    } catch (error) {
        console.error('Error pausing scheduler:', error);
        showNotification('Failed to pause scheduler', 'error');
    }
}

async function resumeScheduler() {
    try {
        const response = await fetch(`${API_BASE}/api/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'resume' })
        });

        if (response.ok) {
            showNotification('Scheduler resumed', 'success');
            loadStatus();
        }
    } catch (error) {
        console.error('Error resuming scheduler:', error);
        showNotification('Failed to resume scheduler', 'error');
    }
}

async function triggerCommit() {
    try {
        const response = await fetch(`${API_BASE}/api/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'trigger' })
        });

        if (response.ok) {
            showNotification('Commit triggered!', 'success');
            setTimeout(() => loadData(), 2000);
        }
    } catch (error) {
        console.error('Error triggering commit:', error);
        showNotification('Failed to trigger commit', 'error');
    }
}

function refreshData() {
    showNotification('Refreshing...', 'info');
    loadData();
}

// Helper functions
function extractCommitType(message) {
    if (!message) return 'chore';
    const match = message.match(/^(\w+)(\([^)]+\))?:/);
    if (match) {
        return match[1].toLowerCase();
    }
    return 'chore';
}

function getCommitIcon(success, usedOllama) {
    if (!success) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
        </svg>`;
    }
    if (usedOllama) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect>
            <rect x="9" y="9" width="6" height="6"></rect>
            <line x1="9" y1="1" x2="9" y2="4"></line>
            <line x1="15" y1="1" x2="15" y2="4"></line>
            <line x1="9" y1="20" x2="9" y2="23"></line>
            <line x1="15" y1="20" x2="15" y2="23"></line>
            <line x1="20" y1="9" x2="23" y2="9"></line>
            <line x1="20" y1="14" x2="23" y2="14"></line>
            <line x1="1" y1="9" x2="4" y2="9"></line>
            <line x1="1" y1="14" x2="4" y2="14"></line>
        </svg>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
    </svg>`;
}

function formatTimeAgo(timestamp) {
    const now = new Date();
    const then = new Date(timestamp);
    const seconds = Math.floor((now - then) / 1000);

    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showNotification(message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);

    // Create toast notification
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        padding: 14px 20px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        z-index: 1000;
        animation: slideIn 0.3s ease;
        display: flex;
        align-items: center;
        gap: 10px;
        font-family: 'Outfit', sans-serif;
    `;

    if (type === 'success') {
        toast.style.background = 'rgba(34, 197, 94, 0.15)';
        toast.style.color = '#22c55e';
        toast.style.border = '1px solid rgba(34, 197, 94, 0.3)';
    } else if (type === 'error') {
        toast.style.background = 'rgba(239, 68, 68, 0.15)';
        toast.style.color = '#ef4444';
        toast.style.border = '1px solid rgba(239, 68, 68, 0.3)';
    } else {
        toast.style.background = 'rgba(139, 92, 246, 0.15)';
        toast.style.color = '#8b5cf6';
        toast.style.border = '1px solid rgba(139, 92, 246, 0.3)';
    }

    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Add animation styles
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }
`;
document.head.appendChild(style);

// Handle visibility change - pause refresh when tab is hidden
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (refreshInterval) {
            clearInterval(refreshInterval);
            refreshInterval = null;
        }
    } else {
        if (!refreshInterval) {
            loadData();
            startAutoRefresh();
        }
    }
});
