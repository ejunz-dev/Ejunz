export async function writeClipboard(text: string): Promise<boolean> {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            return false;
        }
    }
    if (typeof document.execCommand !== 'function') return false;
    const element = document.createElement('textarea');
    element.value = text;
    element.setAttribute('readonly', '');
    element.style.position = 'fixed';
    element.style.left = '-9999px';
    document.body.appendChild(element);
    element.select();
    try {
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        element.remove();
    }
}
