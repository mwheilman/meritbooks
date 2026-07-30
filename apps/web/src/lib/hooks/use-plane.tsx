'use client';

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { useMe } from '@/lib/hooks/use-me';
import { availablePlanes, isPlaneAvailable, type Plane } from '@/lib/planes';

interface PlaneContextValue {
  plane: Plane;
  available: Plane[];
  setPlane: (p: Plane) => void;
}

const PlaneContext = createContext<PlaneContextValue>({
  plane: 'books',
  available: ['books'],
  setPlane: () => {},
});

const STORAGE_KEY = 'meritbooks.activePlane';

export function PlaneProvider({ children }: { children: ReactNode }) {
  const { user } = useMe();
  const available = availablePlanes(user);
  const [plane, setPlaneState] = useState<Plane>('books');

  // Restore the last-used plane once, from localStorage.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as Plane | null;
      if (saved && (saved === 'books' || saved === 'practice' || saved === 'platform')) {
        setPlaneState(saved);
      }
    } catch {
      /* localStorage unavailable — default to books */
    }
  }, []);

  // If the viewer can't (or can no longer) access the active plane, fall back.
  useEffect(() => {
    if (!isPlaneAvailable(user, plane)) setPlaneState('books');
  }, [user, plane]);

  const setPlane = useCallback((p: Plane) => {
    setPlaneState(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <PlaneContext.Provider value={{ plane, available, setPlane }}>
      {children}
    </PlaneContext.Provider>
  );
}

export function usePlane(): PlaneContextValue {
  return useContext(PlaneContext);
}
