import $ from 'jquery';
import { AutoloadPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

export default new AutoloadPage('client_chat_detail', async () => {
    function toggleToolResult(link) {
        const resultDiv = link.closest('.message-tool').querySelector('.tool-result');
        if (resultDiv.style.display === 'none') {
            resultDiv.style.display = 'block';
            link.textContent = i18n('Hide result');
        } else {
            resultDiv.style.display = 'none';
            link.textContent = i18n('View result');
        }
    }

    function playAudio(audioId, iconElement) {
        const audio = document.getElementById(audioId);
        if (!audio) return;
        
        if (audio.paused) {
            audio.play().then(() => {
                iconElement.style.opacity = '0.5';
                audio.onended = () => {
                    iconElement.style.opacity = '1';
                };
            }).catch((error) => {
                console.error('Failed to play audio:', error);
                alert(i18n('Failed to play audio. The audio format may not be supported by your browser.'));
            });
        } else {
            audio.pause();
            audio.currentTime = 0;
            iconElement.style.opacity = '1';
        }
    }

    function downloadAudio(url, filename) {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function deleteChat(conversationId, clientId) {
        if (!confirm(i18n('Are you sure you want to delete this conversation?'))) {
            return;
        }
        
        const domainId = window.location.pathname.match(/\/d\/([^\/]+)/)?.[1];
        if (!domainId) return;
        
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
                const pathMatch = window.location.pathname.match(/\/client\/(\d+)\/chats/);
                if (pathMatch) {
                    window.location.href = `/d/${domainId}/client/${pathMatch[1]}/chats`;
                } else {
                    window.location.reload();
                }
            } else {
                alert(i18n('Failed to delete conversation'));
            }
        })
        .catch(error => {
            console.error('Failed to delete chat:', error);
            alert(i18n('Failed to delete conversation'));
        });
    }

    // Load chat list for sidebar
    $(document).ready(function() {
        const pathMatch = window.location.pathname.match(/\/d\/([^\/]+)\/client\/(\d+)/);
        if (!pathMatch) return;
        
        const domainId = pathMatch[1];
        const clientId = pathMatch[2];
        
        fetch(`/d/${domainId}/client/${clientId}/chats`)
            .then(response => response.text())
            .then(html => {
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const chatList = doc.querySelector('#chat-list-container');
                if (chatList) {
                    const $container = $('#chat-list-container');
                    if ($container.length) {
                        $container.html(chatList.innerHTML);
                    }
                }
            })
            .catch(error => {
                console.error('Failed to load chat list:', error);
            });
    });

    // Bind event handlers using jQuery event delegation
    $(document).on('click', '.tool-result-toggle', function(e) {
        e.preventDefault();
        toggleToolResult(this);
    });
    
    $(document).on('click', '.audio-play-btn:not(.disabled)', function() {
        const $btn = $(this);
        const audioId = $btn.attr('data-audio-id');
        if (audioId) {
            playAudio(audioId, this);
        }
    });
    
    $(document).on('click', '.audio-download-btn:not(.disabled)', function() {
        const $btn = $(this);
        const url = $btn.attr('data-audio-url');
        const filename = $btn.attr('data-filename');
        if (url && filename) {
            downloadAudio(url, filename);
        }
    });
    
    $(document).on('click', '.chat-delete-action', function(e) {
        e.stopPropagation();
        const $btn = $(this);
        const conversationId = parseInt($btn.attr('data-conversation-id'), 10);
        const clientId = parseInt($btn.attr('data-client-id'), 10);
        if (conversationId && clientId) {
            deleteChat(conversationId, clientId);
        }
    });
});

