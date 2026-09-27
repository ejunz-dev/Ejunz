import { useId, type ReactNode } from 'react';
import { EjunzLogo } from '../../../icons';
import css from './HeroShell.module.css';

function HeroGlow() {
    const filterId = `empty-glow-${useId().replace(/:/g, '')}`;
    return <svg className={css.glow} viewBox="0 0 1051 468" fill="none" aria-hidden="true">
        <defs>
            <filter id={filterId} x="0" y="0" width="1051" height="468" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
                <feFlood floodOpacity="0" result="BackgroundImageFix" />
                <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
                <feGaussianBlur stdDeviation="50" result="effect1_foregroundBlur" />
            </filter>
        </defs>
        <g filter={`url(#${filterId})`}>
            <ellipse cx="525.5" cy="234" rx="425.5" ry="134" fill="#6187D8" fillOpacity="0.08" />
        </g>
    </svg>;
}

export function HeroShell({ children }: { children: ReactNode }) {
    return <div className={css.root}>
        <div className={css.stack}>
            <div className={css.headline}>
                <span className={css.logoHitbox}><EjunzLogo size={30} className={css.logo} /></span>
                <span className={css.headlineText}>Ejunz agent</span>
            </div>
            <div className={css.body}>
                <HeroGlow />
                {children}
            </div>
        </div>
    </div>;
}
