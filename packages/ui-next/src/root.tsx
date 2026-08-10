import { StrictMode } from 'react';
import App from './app';
import { PageDataProvider, type PageData } from './context/page-data';
import { RouterProvider } from './context/router';

export interface UiNextRootProps {
  initial: PageData;
}

export default function UiNextRoot({ initial }: UiNextRootProps) {
  return (
    <StrictMode>
      <PageDataProvider initial={initial}>
        <RouterProvider>
          <App />
        </RouterProvider>
      </PageDataProvider>
    </StrictMode>
  );
}
