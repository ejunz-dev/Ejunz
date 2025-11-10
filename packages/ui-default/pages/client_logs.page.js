import { AutoloadPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

export default new AutoloadPage('client_logs', async () => {
    const [{ default: Sock }] = await Promise.all([
        import('../components/socket'),
    ]);

    const container = document.getElementById('logContainer');
    const clearBtn = document.getElementById('clearLogs');
    const lockBtn = document.getElementById('scrollLock');
    
    if (!container || !clearBtn || !lockBtn) return;
    
    let scrollLocked = true;
    let ws = null;
    const clientId = parseInt(container.dataset.clientId || '0', 10);
    const domainId = container.dataset.domainId || '';

    if (!clientId || !domainId) return;

    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const wsUrl = `${protocol}//${host}/d/${domainId}/client/logs/ws?clientId=${clientId}`;
        
        ws = new Sock(wsUrl, false, true);
        
        ws.onopen = () => {
            addLogEntry({
                time: new Date().toISOString(),
                level: 'info',
                message: 'WebSocket connection established'
            });
        };
        
        ws.onmessage = (msg, data) => {
            try {
                const parsed = typeof data === 'string' ? JSON.parse(data) : data;
                
                if (parsed.type === 'history') {
                    container.innerHTML = '';
                    parsed.logs.forEach(log => addLogEntry(log));
                } else if (parsed.type === 'log') {
                    addLogEntry(parsed.data);
                }
            } catch (e) {
                console.error('Failed to parse WebSocket message:', e);
            }
        };
        
        ws.onclose = (code, reason) => {
            addLogEntry({
                time: new Date().toISOString(),
                level: 'warn',
                message: `WebSocket disconnected: ${reason || 'unknown reason'} (code: ${code})`
            });
        };
    }
    
    function addLogEntry(log) {
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.setAttribute('data-level', log.level);
        
        const timeStr = new Date(log.time).toLocaleString();
        
        entry.innerHTML = `
            <span class="log-time">[${timeStr}]</span>
            <span class="log-level log-${log.level}">${log.level}</span>
            <span class="log-message">${escapeHtml(log.message)}</span>
        `;
        
        container.appendChild(entry);
        
        if (scrollLocked) {
            container.scrollTop = container.scrollHeight;
        }
        
        // Limit log entries
        while (container.children.length > 1000) {
            container.removeChild(container.firstChild);
        }
    }
    
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    clearBtn.addEventListener('click', () => {
        container.innerHTML = '';
    });
    
    lockBtn.addEventListener('click', () => {
        scrollLocked = !scrollLocked;
        lockBtn.classList.toggle('active', scrollLocked);
        const lockText = i18n('Lock Scroll');
        const freeText = i18n('Free Scroll');
        lockBtn.textContent = scrollLocked ? `🔒 ${lockText}` : `🔓 ${freeText}`;
        
        if (scrollLocked) {
            container.scrollTop = container.scrollHeight;
        }
    });
    
    connectWebSocket();
});

