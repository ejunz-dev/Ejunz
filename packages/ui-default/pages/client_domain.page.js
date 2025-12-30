import $ from 'jquery';
import Notification from 'vj/components/notification';
import { AutoloadPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

export default new AutoloadPage('client_domain', async () => {
    function deleteToken(clientId) {
        if (!confirm(i18n('Are you sure you want to delete the Token? Connections using this Token will be disconnected.'))) return;
        
        $.ajax({
            url: `/d/${(window.UiContext?.domainId || 'system')}/client/${clientId}/delete-token`,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ clientId }),
        }).then((response) => {
            if (response.success) {
                Notification.success(i18n('Token deleted successfully'));
                setTimeout(() => location.reload(), 1000);
            }
        }).catch((error) => {
            Notification.error(i18n('Failed to delete Token: {0}').replace('{0}', error.responseJSON?.error || error.message || i18n('Unknown error')));
        });
    }

    function copyEndpoint() {
        const endpoint = $('#ws-endpoint').text();
        navigator.clipboard.writeText(endpoint).then(() => {
            Notification.success(i18n('Copied to clipboard'));
        }).catch(() => {
            Notification.error(i18n('Copy failed'));
        });
    }

    function copyBaseEndpoint() {
        const endpoint = $('#client-endpoint-base').text();
        navigator.clipboard.writeText(endpoint).then(() => {
            Notification.success(i18n('Copied to clipboard'));
        }).catch(() => {
            Notification.error(i18n('Copy failed'));
        });
    }

    $(document).on('click', '.client-delete-token-btn', function() {
        const clientId = $(this).data('client-id');
        deleteToken(clientId);
    });

    $(document).on('click', '.client-copy-endpoint-btn', copyEndpoint);
    $(document).on('click', '.client-copy-base-endpoint-btn', copyBaseEndpoint);

    $(document).on('submit', '.client-delete-form', function(e) {
        if (!confirm(i18n('Are you sure you want to delete this client?'))) {
            e.preventDefault();
        }
    });
});

