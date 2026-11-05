import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource/orbitron/600.css";
import "@fontsource/orbitron/800.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "./styles.css";

// The table listens on this machine only; the port can be changed with VITE_TABLE_PORT.
const port = import.meta.env.VITE_TABLE_PORT ?? "8787";
createRoot(document.getElementById("root")!).render(<App url={`ws://127.0.0.1:${port}/ws`} />);
