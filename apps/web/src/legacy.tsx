import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { App } from "./App.js";
import "./styles.css";

/**
 * The server dashboard, loaded only when it is opened. Its stylesheet sets global
 * rules, so the chat never loads it. Fonts are the bundled Geist: nothing from Google.
 */
export default function LegacyDashboard() {
  return <App />;
}
