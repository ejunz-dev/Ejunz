import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

export interface MobileNavAction {
  id: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
  popup?: ReactNode;
  popupOpen?: boolean;
  onClick: () => void;
}

interface NavigationContextValue {
  mobileNavLeft: MobileNavAction[];
  mobileNavRight: MobileNavAction[];
  setMobileNavActions: (left: MobileNavAction[], right: MobileNavAction[]) => void;
}

type MobileNavState = Pick<NavigationContextValue, 'mobileNavLeft' | 'mobileNavRight'>;

let state: MobileNavState = { mobileNavLeft: [], mobileNavRight: [] };
const listeners = new Set<() => void>();

const setMobileNavActions = (left: MobileNavAction[], right: MobileNavAction[]) => {
  state = { mobileNavLeft: left, mobileNavRight: right };
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = () => state;
const contextValue: NavigationContextValue = { ...state, setMobileNavActions };
const NavigationContext = createContext<NavigationContextValue>(contextValue);

export function NavigationProvider({ children }: { children: ReactNode }) {
  return <NavigationContext.Provider value={contextValue}>{children}</NavigationContext.Provider>;
}

export function useNavigationActions(): NavigationContextValue {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const context = useContext(NavigationContext);
  return { ...context, ...state };
}
