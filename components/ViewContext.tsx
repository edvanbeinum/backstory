"use client";

import { createContext, useContext, type ReactNode } from "react";

/** The open repo, and the branch it's open on when that isn't the checkout's. */
export interface OpenView {
  repo: string;
  ref: string | null;
}

const ViewContext = createContext<OpenView>({ repo: "", ref: null });

export function ViewProvider({
  value,
  children,
}: {
  value: OpenView;
  children: ReactNode;
}) {
  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>;
}

export function useView(): OpenView {
  return useContext(ViewContext);
}
