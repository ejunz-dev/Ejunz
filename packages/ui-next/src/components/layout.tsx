import { defineSlot } from '../registry';
import { Navigation } from './navigation';
import { Footer } from './footer';

import './navigation/navigation.css';
import './footer/footer.css';
import './layout.css';

const Layout = defineSlot('layout:default', ({ children }: React.PropsWithChildren) => (
  <div className="uix-shell">
    <Navigation />
    <div className="uix-shell__panel">
      <main className="uix-shell__main">{children}</main>
      <Footer />
    </div>
  </div>
));

export default Layout;
