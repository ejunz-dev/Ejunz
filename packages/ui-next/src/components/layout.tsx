import { useEffect } from 'react';
import { useUserContext } from '../context/page-data';
import { defineSlot } from '../registry';
import { Navigation } from './navigation';
import { Footer } from './footer';

import './navigation/navigation.css';
import './footer/footer.css';
import './layout.css';

const Layout = defineSlot('layout:default', ({ children }: React.PropsWithChildren) => {
  const user = useUserContext();
  const theme = user.theme === 'dark' ? 'dark' : 'light';

  useEffect(() => {
    document.documentElement.classList.toggle('theme--dark', theme === 'dark');
    document.documentElement.classList.toggle('theme--light', theme === 'light');
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className={`uix-shell theme--${theme}`}>
      <Navigation />
      <div className="uix-shell__panel">
        <main className="uix-shell__main">{children}</main>
        <Footer />
      </div>
    </div>
  );
});

export default Layout;
