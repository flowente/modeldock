import { App } from "./App.js";
import "./styles.css";

/**
 * The server dashboard, loaded only when it is opened. Its stylesheet sets global
 * rules and pulls fonts from Google: the chat never loads it.
 */
export default function LegacyDashboard() {
  return <App />;
}
