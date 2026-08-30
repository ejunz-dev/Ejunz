import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

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

const NavigationContext = createContext<NavigationContextValue | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState({ left: [] as MobileNavAction[], right: [] as MobileNavAction[] });
  const setMobileNavActions = useCallback((left: MobileNavAction[], right: MobileNavAction[]) => {
    setActions({ left, right });
  }, []);
  const value = useMemo(() => ({
    mobileNavLeft: actions.left,
    mobileNavRight: actions.right,
    setMobileNavActions,
  }), [actions.left, actions.right, setMobileNavActions]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigationActions(): NavigationContextValue {
  const context = useContext(NavigationContext);
  if (!context) throw new Error('useNavigationActions must be used within NavigationProvider');
  return context;
}
