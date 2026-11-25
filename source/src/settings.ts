import "./app.css";
import { mount } from "svelte";
import { installNativeMenuGuard } from "./lib/context-menu";
import Settings from "./Settings.svelte";
import { perf } from "./lib/perf-recorder";

perf.watchErrors();
// Right-clicks: Ember's own menus, or none (Thunderbird's menu only where you type).
installNativeMenuGuard(window);

mount(Settings, { target: document.getElementById("app")! });
