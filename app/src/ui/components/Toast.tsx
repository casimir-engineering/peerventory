import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface ToastItem {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

interface ToastApi {
  toast(message: string): void;
  toastError(message: string): void;
}

const ToastContext = createContext<ToastApi>({
  toast: () => {},
  toastError: () => {},
});

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((message: string, tone: 'info' | 'error') => {
    const id = nextId.current++;
    setItems((prev) => [...prev.slice(-2), { id, message, tone }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, tone === 'error' ? 5200 : 2600);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast: (message: string) => push(message, 'info'),
      toastError: (message: string) => push(message, 'error'),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-layer" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={t.tone === 'error' ? 'toast error' : 'toast'} role="status">
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
