import React from 'react';

type IconProps = { size?: number; color?: string; className?: string; style?: React.CSSProperties };

export function CardTextIcon({ size = 16, color, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={color || 'currentColor'} aria-hidden {...rest}>
      <path fillRule="evenodd" clipRule="evenodd" d="M1.5 2h13l.5.5v10l-.5.5h-13l-.5-.5v-10l.5-.5zM2 3v9h12V3H2zm2 2h8v1H4V5zm6 2H4v1h6V7zM4 9h4v1H4V9z" />
    </svg>
  );
}

export function CardPdfIcon({ size = 16, color, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={color || 'currentColor'} aria-hidden {...rest}>
      <path fillRule="evenodd" clipRule="evenodd" d="M13.85 4.44l-3.28-3.3-.35-.14H2.5l-.5.5V7h1V2h6v3.5l.5.5H13v1h1V4.8l-.15-.36zM10 5V2l3 3h-3zM2.5 8l-.5.5v6l.5.5h11l.5-.5v-6l-.5-.5h-11zM13 13v1H3V9h10v4zm-8-1h-.32v1H4v-3h1.06c.75 0 1.13.36 1.13 1a.94.94 0 0 1-.32.72A1.33 1.33 0 0 1 5 12zm-.06-1.45h-.26v.93h.26c.36 0 .54-.16.54-.47 0-.31-.18-.46-.54-.46zM9 12.58a1.48 1.48 0 0 0 .44-1.12c0-1-.53-1.46-1.6-1.46H6.78v3h1.06A1.6 1.6 0 0 0 9 12.58zm-1.55-.13v-1.9h.33a.94.94 0 0 1 .7.25.91.91 0 0 1 .25.67 1 1 0 0 1-.25.72.94.94 0 0 1-.69.26h-.34zm4.45-.61h-.97V13h-.68v-3h1.74v.55h-1.06v.74h.97v.55z" />
    </svg>
  );
}

export function CardImageIcon({ size = 16, color, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={color || 'currentColor'} aria-hidden {...rest}>
      <path fillRule="evenodd" clipRule="evenodd" d="M14.25 4.74L11 6.62V4.5l-.5-.5h-9l-.5.5v7l.5.5h9l.5-.5v-2l3.25 1.87.75-.47V5.18l-.75-.44zM10 11H2V5h8v6zm4-1l-3-1.7v-.52L14 6v4z" />
    </svg>
  );
}

export function CardVideoIcon({ size = 16, color, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={color || 'currentColor'} aria-hidden {...rest}>
      <path fillRule="evenodd" clipRule="evenodd" d="M14 7H13V9.49982C12.5822 9.18597 12.0628 9 11.5 9C10.1193 9 9 10.1193 9 11.5C9 12.8807 10.1193 14 11.5 14C12.8807 14 14 12.8807 14 11.5V7ZM11.5 10C12.3284 10 13 10.6716 13 11.5C13 12.3284 12.3284 13 11.5 13C10.6716 13 10 12.3284 10 11.5C10 10.6716 10.6716 10 11.5 10Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M13.4688 2.00098L5.46881 2.50098L5 3V10.4998C4.58217 10.186 4.0628 10 3.5 10C2.11929 10 1 11.1193 1 12.5C1 13.8807 2.11929 15 3.5 15C4.88071 15 6 13.8807 6 12.5V6.46974L13 6.03224V7H14V2.5L13.4688 2.00098ZM13 3.03223V5.03029L6 5.46779V3.46973L13 3.03223ZM3.5 11C4.32843 11 5 11.6716 5 12.5C5 13.3284 4.32843 14 3.5 14C2.67157 14 2 13.3284 2 12.5C2 11.6716 2.67157 11 3.5 11Z" />
    </svg>
  );
}

export function CardAudioIcon({ size = 16, color, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={color || 'currentColor'} aria-hidden {...rest}>
      <path fillRule="evenodd" clipRule="evenodd" d="M14 7H13V9.49982C12.5822 9.18597 12.0628 9 11.5 9C10.1193 9 9 10.1193 9 11.5C9 12.8807 10.1193 14 11.5 14C12.8807 14 14 12.8807 14 11.5V7ZM11.5 10C12.3284 10 13 10.6716 13 11.5C13 12.3284 12.3284 13 11.5 13C10.6716 13 10 12.3284 10 11.5C10 10.6716 10.6716 10 11.5 10Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M13.4688 2.00098L5.46881 2.50098L5 3V10.4998C4.58217 10.186 4.0628 10 3.5 10C2.11929 10 1 11.1193 1 12.5C1 13.8807 2.11929 15 3.5 15C4.88071 15 6 13.8807 6 12.5V6.46974L13 6.03224V7H14V2.5L13.4688 2.00098ZM13 3.03223V5.03029L6 5.46779V3.46973L13 3.03223ZM3.5 11C4.32843 11 5 11.6716 5 12.5C5 13.3284 4.32843 14 3.5 14C2.67157 14 2 13.3284 2 12.5C2 11.6716 2.67157 11 3.5 11Z" />
    </svg>
  );
}

export function CardCodeIcon({ size = 16, color, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={color || 'currentColor'} aria-hidden {...rest}>
      <path d="M13.85 4.44002L10.571 1.13902L10.22 0.999023H2.5L2 1.49902V14.499L2.5 14.999H13.5L14 14.499V4.80002L13.85 4.44002ZM13 14H3V2.00002H9V5.50002L9.5 6.00002H13V14ZM10 5.00002V2.00002L13 5.00002H10ZM6.854 7.85402L5.208 9.50002L6.854 11.146L6.147 11.853L4.147 9.85302V9.14602L6.147 7.14602L6.854 7.85402ZM9.146 7.85402L9.853 7.14702L11.853 9.14702V9.85402L9.853 11.854L9.146 11.147L10.792 9.50102L9.146 7.85402Z" />
    </svg>
  );
}

export function CardFileOtherIcon({ size = 16, color, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={color || 'currentColor'} aria-hidden {...rest}>
      <path d="M13.85 4.44002L10.571 1.13902L10.22 0.999023H2.5L2 1.49902V14.499L2.5 14.999H13.5L14 14.499V4.80002L13.85 4.44002ZM13 14H3V2.00002H10L13 5.00002V14ZM5.937 12.286H6.729V12.958H4.293V12.286H5.091V9.88802L4.272 10.066V9.37902L5.937 9.04302V12.286ZM9.554 9.00802C9.083 9.00802 8.724 9.18402 8.475 9.53402C8.228 9.88302 8.104 10.392 8.104 11.059C8.104 12.346 8.562 12.991 9.479 12.991C9.935 12.991 10.285 12.817 10.529 12.469C10.774 12.122 10.897 11.622 10.897 10.971C10.897 9.66202 10.449 9.00702 9.554 9.00702V9.00802ZM9.506 12.341C9.146 12.341 8.966 11.907 8.966 11.038C8.966 10.116 9.15 9.65502 9.517 9.65502C9.86 9.65502 10.033 10.103 10.033 10.998C10.033 11.893 9.857 12.34 9.507 12.341H9.506Z" />
    </svg>
  );
}

export function FolderClosedIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden {...rest}>
      <path fillRule="evenodd" clipRule="evenodd" d="M7.17 3H1.5l-.5.5V5h1V4h5.33l.5.5V7H14L13 4.91l-.44-.12-.5-1.13L11.98 3H7.17zM14 8H2v4.5l.5.5h11l.5-.5V8zm-1 0v4H3V8h10z" />
    </svg>
  );
}

export function FolderOpenedIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden {...rest}>
      <path fillRule="evenodd" clipRule="evenodd" d="M1.5 3l.5-.5h5.67l.5.5L9 5h4.5l.5.5v1.19l-.02.01 1.99 5.52-.47.78H2l-.5-.5V3zm5.5 2L6 4.5H2V5h5z" />
    </svg>
  );
}
