import "./app.css";
import { mount } from "svelte";
import { installNativeMenuGuard } from "./lib/context-menu";
import App from "./App.svelte";
import { perf } from "./lib/perf-recorder";

perf.watchErrors();
// Right-clicks: Ember's own menus, or none (Thunderbird's menu only where you type).
installNativeMenuGuard(window);

const app = mount(App, { target: document.getElementById("app")! });
export default app;
