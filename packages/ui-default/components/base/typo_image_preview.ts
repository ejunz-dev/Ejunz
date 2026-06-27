import Notification from 'vj/components/notification';
import { i18n } from 'vj/utils';

const VIEWERJS_ROOT_SELECTOR = '.viewer-container, .viewer-fixed';
const IMAGE_PREVIEW_DIALOG_SELECTOR = '.dialog.withBg';

export function isTypoImagePreviewOverlay(target: Element | null): boolean {
  if (!target) return false;
  return !!target.closest(VIEWERJS_ROOT_SELECTOR)
    || !!target.closest(IMAGE_PREVIEW_DIALOG_SELECTOR);
}

async function getPreviewImage(): Promise<((link: string) => Promise<void>) | null> {
  let previewImage = (window as any).Ejunz?.components?.preview?.previewImage as
    | ((link: string) => Promise<void>)
    | undefined;
  if (!previewImage) {
    await import('vj/components/preview/preview.page');
    previewImage = (window as any).Ejunz?.components?.preview?.previewImage;
  }
  return previewImage || null;
}

export async function previewTypoImage(imageUrl: string): Promise<void> {
  if (!imageUrl) return;
  try {
    const previewImage = await getPreviewImage();
    if (previewImage) {
      await previewImage(imageUrl);
      return;
    }
    const { InfoDialog } = await import('vj/components/dialog/index');
    const $ = (await import('jquery')).default;
    const isMobile = window.innerWidth <= 600;
    const maxHeight = isMobile ? 'calc(90vh - 60px)' : 'calc(80vh - 45px)';
    const padding = isMobile ? '10px' : '20px';
    const $img = $(`<img src="${imageUrl}" style="max-width: 100%; max-height: ${maxHeight}; width: auto; height: auto;" />`);
    const dialog = new InfoDialog({
      $body: $(`<div class="typo" style="padding: ${padding}; text-align: center;"></div>`).append($img),
      $action: null,
      cancelByClickingBack: true,
      cancelByEsc: true,
    });
    await dialog.open();
  } catch (error) {
    console.error('Image preview failed:', error);
    Notification.error(i18n('Image preview failed'));
  }
}

export function attachTypoImagePreviewHandlers(container: HTMLElement): void {
  container.querySelectorAll('img').forEach((img) => {
    const next = img.cloneNode(true) as HTMLImageElement;
    img.parentNode?.replaceChild(next, img);
    next.style.cursor = 'pointer';
    next.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const imageUrl = next.src || next.getAttribute('src') || '';
      if (!imageUrl) return;
      void previewTypoImage(imageUrl);
    });
  });
}
