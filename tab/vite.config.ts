import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Project Pages site: https://processmaker.github.io/blue-standup-bot/
export default defineConfig({
  plugins: [react()],
  base: "/blue-standup-bot/",
});
