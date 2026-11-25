import "./app.css";
import { mount } from "svelte";
import { installNativeMenuGuard } from "./lib/context-menu";
import Options from "./Options.svelte";
// Right-clicks: Ember's own menus, or none (Thunderbird's menu only where you type).
installNativeMenuGuard(window);

mount(Options, { target: document.getElementById("app")! });
