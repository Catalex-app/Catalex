import { create } from "zustand";
import { persist } from "zustand/middleware";
import { synchronizePersistedStore } from "@/lib/persisted-store-sync";

export const useOnboardingStore = create<{
  completed: boolean;
  step: number;
  setStep: (step: number) => void;
  finish: () => void;
}>()(
  persist(
    (set) => ({
      completed: false,
      step: 0,
      setStep: (step) => set({ step: Math.max(0, Math.min(3, step)) }),
      finish: () => set({ completed: true }),
    }),
    { name: "catalex-onboarding" },
  ),
);
synchronizePersistedStore(useOnboardingStore);
