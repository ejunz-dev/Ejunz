import { useCallback, useEffect, useState } from 'react';
import { useUserContext } from '@ejunz/ui-next';

/**
 * The theme this plugin's pages render under.
 *
 * The account carries the choice, so a page starts from it. Making it real
 * takes three markers: `body[data-ds-dark-theme]` switches this plugin's design
 * tokens, `html.theme--dark` is the marker the shell's own components read, and
 * each page's `.eja-app` root carries the attribute its styles key on. A page
 * that switches the theme in place updates the document markers for every page,
 * which is why they live here rather than in one page.
 * @returns the current darkness and the setter a settings surface calls.
 */
export function useAgentTheme(): { dark: boolean; applyTheme: (next: boolean) => void } {
    const user = useUserContext();
    const [dark, setDark] = useState(user?.theme === 'dark');
    const applyTheme = useCallback((next: boolean) => { setDark(next); }, []);
    useEffect(() => {
        document.body.toggleAttribute('data-ds-dark-theme', dark);
        document.documentElement.classList.toggle('theme--dark', dark);
    }, [dark]);
    return { dark, applyTheme };
}
