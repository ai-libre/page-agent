/**
 * Benchmark test for @page-agent/connector
 *
 * Compares browser backends (Chromium, Lightpanda) on:
 *   - Startup time
 *   - Page navigation speed
 *   - DOM extraction (getBrowserState) speed
 *   - Action execution speed (click, input, select, scroll)
 *   - Memory usage
 *
 * Usage:
 *   node test/benchmark.test.mjs [--lightpanda]
 */
import { execSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { createServer } from 'http'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Dynamic import of our built connector
const { RemotePageController, CdpClient } = await import('../dist/esm/connector.js')

// ─── Config ───
const CHROME_PATH = '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome'
const LIGHTPANDA_PATH =
	process.env.LIGHTPANDA_EXECUTABLE_PATH || `${process.env.HOME}/.cache/lightpanda-node/lightpanda`

const useLightpanda = process.argv.includes('--lightpanda')
const CDP_PORT = 9224
const HTTP_PORT = 8766

// ─── Complex test page (more realistic for benchmarking) ───
const TEST_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Benchmark Test Page</title>
  <style>
    body { font-family: sans-serif; margin: 20px; }
    .card { border: 1px solid #ccc; padding: 15px; margin: 10px; border-radius: 8px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f4f4f4; }
    nav { display: flex; gap: 10px; padding: 10px; background: #333; }
    nav a { color: white; text-decoration: none; padding: 5px 10px; }
    .form-group { margin: 10px 0; }
    .form-group label { display: block; margin-bottom: 5px; }
    .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 8px; }
  </style>
</head>
<body>
  <nav>
    <a href="#">Home</a><a href="#">Products</a><a href="#">Services</a>
    <a href="#">About</a><a href="#">Contact</a>
  </nav>

  <h1>Dashboard</h1>
  <p>Welcome to the benchmark test page with realistic DOM complexity.</p>

  <div class="card">
    <h2>Quick Actions</h2>
    <button id="btn1" onclick="document.getElementById('output').textContent='action-1'">Action 1</button>
    <button id="btn2" onclick="document.getElementById('output').textContent='action-2'">Action 2</button>
    <button id="btn3" onclick="document.getElementById('output').textContent='action-3'">Action 3</button>
    <div id="output"></div>
  </div>

  <div class="card">
    <h2>Data Entry Form</h2>
    <div class="form-group">
      <label for="name">Name</label>
      <input id="name" type="text" placeholder="Enter name" />
    </div>
    <div class="form-group">
      <label for="email">Email</label>
      <input id="email" type="email" placeholder="Enter email" />
    </div>
    <div class="form-group">
      <label for="role">Role</label>
      <select id="role">
        <option value="">Select role</option>
        <option value="admin">Administrator</option>
        <option value="user">User</option>
        <option value="viewer">Viewer</option>
      </select>
    </div>
    <div class="form-group">
      <label for="notes">Notes</label>
      <textarea id="notes" rows="3" placeholder="Additional notes"></textarea>
    </div>
    <button id="submit-btn" type="button">Submit</button>
  </div>

  <div class="card">
    <h2>Data Table</h2>
    <table>
      <thead>
        <tr><th>ID</th><th>Name</th><th>Status</th><th>Date</th><th>Actions</th></tr>
      </thead>
      <tbody>
        ${Array.from(
					{ length: 20 },
					(_, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>Item ${i + 1}</td>
          <td>${['Active', 'Pending', 'Closed'][i % 3]}</td>
          <td>2024-0${(i % 9) + 1}-${String(i + 1).padStart(2, '0')}</td>
          <td><button class="row-btn" data-id="${i + 1}">Edit</button></td>
        </tr>`
				).join('')}
      </tbody>
    </table>
  </div>

  <div style="height: 2000px;">
    <p>Scroll area for testing</p>
  </div>
  <div id="bottom">Bottom of page</div>
</body>
</html>`

// ─── Timing helpers ───
function hrMs() {
	return performance.now()
}

function elapsed(start) {
	return (performance.now() - start).toFixed(1)
}

// ─── Results collector ───
const results = []

function record(name, ms) {
	results.push({ name, ms: parseFloat(ms) })
}

// ─── Memory helper ───
function getProcessMemory(pid) {
	try {
		const status = execSync(`cat /proc/${pid}/status 2>/dev/null`).toString()
		const vmRss = status.match(/VmRSS:\s+(\d+)/)?.[1]
		return vmRss ? parseInt(vmRss) : null
	} catch {
		return null
	}
}

// ═══════════════════════════════════════════
// Start HTTP server
// ═══════════════════════════════════════════
const httpServer = createServer((req, res) => {
	res.writeHead(200, { 'Content-Type': 'text/html' })
	res.end(TEST_HTML)
})
await new Promise((resolve) => httpServer.listen(HTTP_PORT, resolve))

// ═══════════════════════════════════════════
// Launch browser
// ═══════════════════════════════════════════
let browserName, browserPath, browserArgs, browserProc

if (useLightpanda) {
	browserName = 'Lightpanda'
	browserPath = LIGHTPANDA_PATH
	if (!existsSync(browserPath)) {
		console.error(`Lightpanda binary not found at: ${browserPath}`)
		console.error('Set LIGHTPANDA_EXECUTABLE_PATH or run with --chromium')
		process.exit(1)
	}
	browserArgs = ['serve', '--host', '127.0.0.1', '--port', String(CDP_PORT)]
} else {
	browserName = 'Chromium'
	browserPath = CHROME_PATH
	browserArgs = [
		'--headless=new',
		`--remote-debugging-port=${CDP_PORT}`,
		'--no-sandbox',
		'--disable-gpu',
		'--disable-dev-shm-usage',
		'--no-first-run',
		'--disable-extensions',
		'about:blank',
	]
}

console.log(`\n${'═'.repeat(50)}`)
console.log(`  BENCHMARK: ${browserName}`)
console.log(`${'═'.repeat(50)}\n`)

// Measure startup time
const startupStart = hrMs()

browserProc = spawn(browserPath, browserArgs, {
	stdio: ['ignore', 'pipe', 'pipe'],
})

// Wait for CDP to be ready
await new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error('Browser startup timeout')), 15000)
	const check = async () => {
		try {
			const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
			if (resp.ok) {
				clearTimeout(timeout)
				resolve()
				return
			}
		} catch {}
		setTimeout(check, 100)
	}
	check()
})

const startupMs = elapsed(startupStart)
record('Browser startup', startupMs)
console.log(`  Browser startup: ${startupMs}ms`)

// Measure memory after startup
const memAfterStartup = getProcessMemory(browserProc.pid)
if (memAfterStartup) {
	record('Memory after startup (KB)', memAfterStartup)
	console.log(`  Memory after startup: ${(memAfterStartup / 1024).toFixed(1)} MB`)
}

// ═══════════════════════════════════════════
// Connect controller
// ═══════════════════════════════════════════
const connectStart = hrMs()
const controller = new RemotePageController({
	cdpUrl: `ws://127.0.0.1:${CDP_PORT}`,
	viewport: { width: 1280, height: 720 },
})
await controller.connect()
const connectMs = elapsed(connectStart)
record('CDP connect', connectMs)
console.log(`  CDP connect: ${connectMs}ms`)

// ═══════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════
const navStart = hrMs()
await controller.navigate(`http://127.0.0.1:${HTTP_PORT}/`)
const navMs = elapsed(navStart)
record('Page navigation', navMs)
console.log(`  Page navigation: ${navMs}ms`)

// ═══════════════════════════════════════════
// getBrowserState (DOM extraction) - run multiple times
// ═══════════════════════════════════════════
const DOM_ITERATIONS = 10
const domTimes = []

for (let i = 0; i < DOM_ITERATIONS; i++) {
	const t = hrMs()
	const state = await controller.getBrowserState()
	domTimes.push(parseFloat(elapsed(t)))

	// First iteration: verify content quality
	if (i === 0) {
		const content = state.content
		const lines = content.split('\n')
		const interactiveCount = lines.filter((l) => /\[\d+\]/.test(l)).length
		console.log(`\n  DOM extraction quality:`)
		console.log(`    Title: ${state.title}`)
		console.log(`    Content lines: ${lines.length}`)
		console.log(`    Interactive elements: ${interactiveCount}`)
		console.log(`    Content size: ${content.length} chars`)
		record('DOM content lines', lines.length)
		record('DOM interactive elements', interactiveCount)
		record('DOM content size (chars)', content.length)
	}
}

const domAvg = (domTimes.reduce((a, b) => a + b) / domTimes.length).toFixed(1)
const domMin = Math.min(...domTimes).toFixed(1)
const domMax = Math.max(...domTimes).toFixed(1)
record('getBrowserState avg', domAvg)
record('getBrowserState min', domMin)
record('getBrowserState max', domMax)
console.log(`\n  getBrowserState (${DOM_ITERATIONS} runs):`)
console.log(`    avg: ${domAvg}ms  min: ${domMin}ms  max: ${domMax}ms`)

// ═══════════════════════════════════════════
// Action benchmarks
// ═══════════════════════════════════════════
console.log('\n  Action benchmarks:')

// Get current state to find element indices
const state = await controller.getBrowserState()
const lines = state.content.split('\n')

// Click
const buttonLine = lines.find((l) => l.includes('Action 1'))
const buttonIndex = buttonLine ? parseInt(buttonLine.match(/\[(\d+)\]/)?.[1]) : 0
const clickStart = hrMs()
await controller.clickElement(buttonIndex)
const clickMs = elapsed(clickStart)
record('clickElement', clickMs)
console.log(`    clickElement: ${clickMs}ms`)

// Input text
const inputLine = lines.find((l) => l.includes('input') && l.includes('Enter name'))
const inputIndex = inputLine ? parseInt(inputLine.match(/\[(\d+)\]/)?.[1]) : 1
const inputStart = hrMs()
await controller.inputText(inputIndex, 'Benchmark Test User')
const inputMs = elapsed(inputStart)
record('inputText', inputMs)
console.log(`    inputText: ${inputMs}ms`)

// Select option
const selectLine = lines.find((l) => l.includes('select') && l.includes('role'))
const selectIndex = selectLine ? parseInt(selectLine.match(/\[(\d+)\]/)?.[1]) : 2
const selectStart = hrMs()
await controller.selectOption(selectIndex, 'Administrator')
const selectMs = elapsed(selectStart)
record('selectOption', selectMs)
console.log(`    selectOption: ${selectMs}ms`)

// Scroll
const scrollStart = hrMs()
await controller.scroll({ down: true, numPages: 2 })
const scrollMs = elapsed(scrollStart)
record('scroll', scrollMs)
console.log(`    scroll: ${scrollMs}ms`)

// Execute JavaScript
const jsStart = hrMs()
await controller.executeJavascript('return document.querySelectorAll("tr").length')
const jsMs = elapsed(jsStart)
record('executeJavascript', jsMs)
console.log(`    executeJavascript: ${jsMs}ms`)

// ═══════════════════════════════════════════
// Rapid-fire DOM extraction (throughput test)
// ═══════════════════════════════════════════
const RAPID_COUNT = 20
const rapidStart = hrMs()
for (let i = 0; i < RAPID_COUNT; i++) {
	await controller.getBrowserState()
}
const rapidMs = elapsed(rapidStart)
const throughput = ((RAPID_COUNT / parseFloat(rapidMs)) * 1000).toFixed(1)
record('Rapid getBrowserState total', rapidMs)
record('getBrowserState throughput (ops/sec)', throughput)
console.log(`\n  Rapid-fire DOM extraction (${RAPID_COUNT} calls):`)
console.log(`    Total: ${rapidMs}ms`)
console.log(`    Throughput: ${throughput} ops/sec`)

// ═══════════════════════════════════════════
// Memory after workload
// ═══════════════════════════════════════════
const memAfterWorkload = getProcessMemory(browserProc.pid)
if (memAfterWorkload) {
	record('Memory after workload (KB)', memAfterWorkload)
	console.log(`\n  Memory after workload: ${(memAfterWorkload / 1024).toFixed(1)} MB`)
	if (memAfterStartup) {
		const growth = ((memAfterWorkload - memAfterStartup) / 1024).toFixed(1)
		console.log(`  Memory growth: ${growth} MB`)
	}
}

// ═══════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════
controller.dispose()
browserProc.kill()
httpServer.close()

// ═══════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`)
console.log(`  RESULTS SUMMARY: ${browserName}`)
console.log(`${'─'.repeat(50)}`)
for (const r of results) {
	console.log(`  ${r.name.padEnd(38)} ${String(r.ms).padStart(10)}`)
}
console.log(`${'═'.repeat(50)}`)

// Output JSON for programmatic comparison
console.log(`\n__BENCHMARK_JSON__${JSON.stringify({ browser: browserName, results })}__END__`)

process.exit(0)
