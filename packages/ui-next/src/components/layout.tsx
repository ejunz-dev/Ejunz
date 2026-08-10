import { defineSlot } from '../registry';

const Layout = defineSlot('layout:default', ({ children }: React.PropsWithChildren) => (
  <>{children}</>
));

export default Layout;
