import { DEFAULT_SCREEN_RULES, type ScreenRules } from "@shadow-run/shared";
import { createContext, useContext } from "react";

/** The rules the screen reads, from the server's snapshot; the book's numbers until it arrives. */
export const RulesContext = createContext<ScreenRules>(DEFAULT_SCREEN_RULES);
export const useRules = () => useContext(RulesContext);

/** Whether the server is in test mode, where a held roll can be rolled again. */
export const TestModeContext = createContext(false);
export const useTestMode = () => useContext(TestModeContext);
