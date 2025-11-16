import $ from 'jquery';
import { AutoloadPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

export default new AutoloadPage('client_chat_list', async () => {
    function loadChatDetail(clientId, conversationId) {
        const pathMatch = window.location.pathname.match(/\/d\/([^\/]+)/);
        if (!pathMatch) return;
        
        const domainId = pathMatch[1];
        const url = `/d/${domainId}/client/${clientId}/chat/${conversationId}`;
        
        fetch(url)
            .then(response => response.text())
            .then(html => {
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const chatDetailContainer = doc.querySelector('#chat-detail-container');
                const chatTitle = doc.querySelector('.section__title');
                const chatDeviceId = doc.querySelector('.section__header > div');
                
                if (chatDetailContainer) {
                    const container = document.getElementById('chat-detail-container');
                    if (container) {
                        container.innerHTML = chatDetailContainer.innerHTML;
                    }
                }
                
                if (chatTitle) {
                    const titleEl = document.getElementById('chat-title');
                    if (titleEl) {
                        titleEl.textContent = chatTitle.textContent;
                    }
                }
                
                if (chatDeviceId) {
                    const deviceEl = document.getElementById('chat-device-id');
                    if (deviceEl) {
                        deviceEl.textContent = chatDeviceId.textContent;
                    }
                }
            })
            .catch(error => {
                console.error('Failed to load chat detail:', error);
                const container = document.getElementById('chat-detail-container');
                if (container) {
                    container.innerHTML = 
                        '<div style="text-align: center; padding: 40px; color: #d32f2f;">' +
                        `<p>${i18n('Failed to load chat details')}</p>` +
                        '</div>';
                }
            });
    }

    function deleteChat(conversationId, clientId) {
        if (!confirm(i18n('Are you sure you want to delete this conversation?'))) {
            return;
        }
        
        const pathMatch = window.location.pathname.match(/\/d\/([^\/]+)/);
        if (!pathMatch) return;
        
        const domainId = pathMatch[1];
        
        fetch(`/d/${domainId}/client/chat/delete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                clientId: clientId,
                conversationId: conversationId
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                location.reload();
            } else {
                alert(i18n('Failed to delete conversation'));
            }
        })
        .catch(error => {
            console.error('Failed to delete chat:', error);
            alert(i18n('Failed to delete conversation'));
        });
    }

    // Bind chat item click events using jQuery (always bind, regardless of path)
    $(document).on('click', '.chat-item', function() {
        const $item = $(this);
        const conversationId = parseInt($item.attr('data-conversation-id'), 10);
        
        // Get clientId from path or from delete button
        const pathMatch = window.location.pathname.match(/\/d\/([^\/]+)\/client\/(\d+)/);
        let clientId = null;
        
        if (pathMatch) {
            clientId = parseInt(pathMatch[2], 10);
        } else {
            // Try to get from delete button in the same item
            const $deleteBtn = $item.find('.chat-delete-btn');
            if ($deleteBtn.length) {
                clientId = parseInt($deleteBtn.attr('data-client-id'), 10);
            }
        }
        
        if (!clientId || !conversationId) {
            console.error('Failed to get clientId or conversationId');
            return;
        }
        
        // Remove selected state from other items
        $('.chat-item').css({
            background: 'transparent',
            color: ''
        });
        
        // Set current item as selected
        $item.css({
            background: '#4a90e2',
            color: 'white'
        });
        
        loadChatDetail(clientId, conversationId);
    });

    // Bind delete button events
    $(document).on('click', '.chat-delete-btn', function(e) {
        e.stopPropagation();
        const $btn = $(this);
        const conversationId = parseInt($btn.attr('data-conversation-id'), 10);
        const clientId = parseInt($btn.attr('data-client-id'), 10);
        if (conversationId && clientId) {
            deleteChat(conversationId, clientId);
        }
    });
    
    // Auto-select first chat if available
    $(document).ready(function() {
        const $firstChat = $('.chat-item').first();
        if ($firstChat.length) {
            $firstChat.trigger('click');
        }
    });
});

