// @ts-check
import { dirname, resolve } from 'path'
import dts from 'unplugin-dts/vite'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	clearScreen: false,
	plugins: [dts({ tsconfigPath: './tsconfig.dts.json', bundleTypes: true })],
	publicDir: false,
	esbuild: {
		keepNames: true,
	},
	build: {
		lib: {
			entry: resolve(__dirname, 'src/index.ts'),
			name: 'PageAgentConnector',
			fileName: 'connector',
			formats: ['es'],
		},
		outDir: resolve(__dirname, 'dist', 'esm'),
		rollupOptions: {
			external: [
				// Node built-ins
				'node:events',
				// Internal packages — bundled at build time via inject script
				// but kept external for the main entry
				/^@page-agent\//,
			],
		},
		minify: false,
		sourcemap: true,
		target: 'node20',
	},
	define: {
		'process.env.NODE_ENV': '"production"',
	},
})
