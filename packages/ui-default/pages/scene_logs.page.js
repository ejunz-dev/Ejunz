import { AutoloadPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

export default new AutoloadPage('scene_logs', async () => {
    const [{ default: Sock }] = await Promise.all([
        import('../components/socket'),
    ]);

    const container = document.getElementById('logContainer');
    const clearBtn = document.getElementById('clearLogs');
    const lockBtn = document.getElementById('scrollLock');
    const eventFilter = document.getElementById('eventFilter');
    const levelFilter = document.getElementById('levelFilter');
    const applyFiltersBtn = document.getElementById('applyFilters');
    const resetFiltersBtn = document.getElementById('resetFilters');
    
    if (!container || !clearBtn || !lockBtn) return;
    
    let scrollLocked = true;
    let ws = null;
    const sceneId = parseInt(container.dataset.sceneId || '0', 10);
    const domainId = container.dataset.domainId || '';
    let currentEventFilter = '';
    let currentLevelFilter = '';

    if (!sceneId || !domainId) return;

    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const wsUrl = `${protocol}//${host}/d/${domainId}/scene/logs/ws?sid=${sceneId}`;
        
        ws = new Sock(wsUrl, false, true);
        
        ws.onopen = () => {
            addLogEntry({
                time: new Date().toISOString(),
                level: 'info',
                message: 'WebSocket 连接已建立'
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
                level: 'warning',
                message: `WebSocket 连接断开: ${reason || '未知原因'} (代码: ${code})`
            });
        };
    }
    
    function addLogEntry(log) {
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.setAttribute('data-level', log.level || 'info');
        if (log.eventId) {
            entry.setAttribute('data-event-id', log.eventId.toString());
        } else {
            entry.setAttribute('data-event-id', '');
        }
        
        const timeStr = new Date(log.time).toLocaleString('zh-CN');
        
        let eventInfo = '';
        if (log.eventId) {
            eventInfo = `<span class="log-event" style="margin-left: 10px; color: #4ec9b0;">[事件 ${log.eventId}${log.eventName ? ': ' + escapeHtml(log.eventName) : ''}]</span>`;
        }
        
        let detailsInfo = '';
        if (log.details) {
            detailsInfo = `<div class="log-details" style="margin-left: 30px; margin-top: 5px; color: #858585; font-size: 12px;">${escapeHtml(JSON.stringify(log.details, null, 2))}</div>`;
        }
        
        const levelColors = {
            error: '#f44336',
            warning: '#ff9800',
            success: '#4caf50',
            info: '#2196f3'
        };
        const levelBg = levelColors[log.level] || levelColors.info;
        
        entry.innerHTML = `
            <span class="log-time" style="color: #858585;">[${timeStr}]</span>
            <span class="log-level log-${log.level || 'info'}" style="margin-left: 10px; padding: 2px 6px; border-radius: 3px; font-weight: bold; background: ${levelBg}; color: white;">${log.level || 'info'}</span>
            ${eventInfo}
            <span class="log-message" style="margin-left: 10px;">${escapeHtml(log.message || '')}</span>
            ${detailsInfo}
        `;
        
        entry.style.cssText = 'margin-bottom: 8px; padding: 5px; border-left: 3px solid ' + levelBg + ';';
        
        container.appendChild(entry);
        
        // 应用过滤器
        applyFiltersToEntry(entry);
        
        if (scrollLocked) {
            container.scrollTop = container.scrollHeight;
        }
        
        // Limit log entries
        while (container.children.length > 1000) {
            container.removeChild(container.firstChild);
        }
    }
    
    function applyFiltersToEntry(entry) {
        const eventId = entry.getAttribute('data-event-id');
        const level = entry.getAttribute('data-level');
        
        let shouldShow = true;
        
        if (currentEventFilter && eventId !== currentEventFilter) {
            shouldShow = false;
        }
        
        if (currentLevelFilter && level !== currentLevelFilter) {
            shouldShow = false;
        }
        
        if (shouldShow) {
            entry.classList.remove('hidden');
        } else {
            entry.classList.add('hidden');
        }
    }
    
    function applyFilters() {
        currentEventFilter = eventFilter ? eventFilter.value : '';
        currentLevelFilter = levelFilter ? levelFilter.value : '';
        
        // 重新应用过滤器到所有条目
        const entries = container.querySelectorAll('.log-entry');
        entries.forEach(entry => {
            applyFiltersToEntry(entry);
        });
    }
    
    function resetFilters() {
        if (eventFilter) eventFilter.value = '';
        if (levelFilter) levelFilter.value = '';
        currentEventFilter = '';
        currentLevelFilter = '';
        
        // 显示所有条目
        const entries = container.querySelectorAll('.log-entry');
        entries.forEach(entry => {
            entry.classList.remove('hidden');
        });
    }
    
    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }
    
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            container.innerHTML = '';
        });
    }
    
    if (lockBtn) {
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
    }
    
    if (applyFiltersBtn) {
        applyFiltersBtn.addEventListener('click', applyFilters);
    }
    
    if (resetFiltersBtn) {
        resetFiltersBtn.addEventListener('click', resetFilters);
    }
    
    connectWebSocket();
});

