import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { analyticsProxy, assertSafeTarget, resolveTarget } from "./server/proxy.ts";

export default defineConfig(({ command, mode }) => {
	// `vite build` and the tests need no server; dev and preview proxy /api to the backend with the admin token.
	let api: ReturnType<typeof analyticsProxy> | undefined;
	if (command === "serve" && mode !== "test") {
		const target = resolveTarget(process.env);
		assertSafeTarget(target.url);
		console.log(`backend: ${target.url} (${target.token ? "admin token" : "NO admin token"}; ${target.source})`);
		if (!target.token) console.log("  /api answers 503 until you start with --game <the game repo> (its .env holds TYPETORCH_ADMIN_TOKEN)");
		api = analyticsProxy(target);
	}
	return {
		plugins: [react(), tailwindcss(), ...(api ? [api.plugin] : [])],
		resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
		server: { host: "localhost", ...(api ? { proxy: api.proxy } : {}) },
		preview: { host: "localhost", ...(api ? { proxy: api.proxy } : {}) },
		build: { chunkSizeWarningLimit: 600 },
		test: { environment: "node", include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.ts"] },
	};
});
