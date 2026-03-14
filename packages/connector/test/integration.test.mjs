/**
 * Integration test for @page-agent/connector
 *
 * Launches headless Chromium with --remote-debugging-port,
 * then tests RemotePageController against a local HTML page.
 */
import { execSync, spawn } from 'child_process'
import { createServer } from 'http'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Dynamic import of our built connector
const { RemotePageController, CdpClient } = await import('../dist/esm/connector.js')

const CHROME_PATH = '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome'
const CDP_PORT = 9223 // avoid conflicts
const HTTP_PORT = 8765

// ─── Test HTML page ───
const TEST_HTML = `<!DOCTYPE html>
<html>
<head><title>Connector Test Page</title></head>
<body>
  <h1>Hello Page Agent</h1>
  <p>This is a test page for the connector.</p>
  <button id="btn1" onclick="document.getElementById('output').textContent='clicked!'">Click Me</button>
  <input id="input1" type="text" placeholder="Type here" />
  <select id="select1">
    <option value="a">Option A</option>
    <option value="b">Option B</option>
    <option value="c">Option C</option>
  </select>
  <div id="output"></div>
  <div style="height: 2000px;">Tall content for scroll testing</div>
  <div id="bottom">Bottom of page</div>
</body>
</html>`

// ─── Helpers ───
let passed = 0
let failed = 0

function assert(condition, message) {
	if (condition) {
		console.log(`  ✅ ${message}`)
		passed++
	} else {
		console.error(`  ❌ ${message}`)
		failed++
	}
}

function assertIncludes(str, substring, message) {
	assert(String(str).includes(substring), message)
}

// ─── Start HTTP server ───
const httpServer = createServer((req, res) => {
	res.writeHead(200, { 'Content-Type': 'text/html' })
	res.end(TEST_HTML)
})

await new Promise((resolve) => httpServer.listen(HTTP_PORT, resolve))
console.log(`HTTP server listening on port ${HTTP_PORT}`)

// ─── Start Chromium ───
const chrome = spawn(
	CHROME_PATH,
	[
		'--headless=new',
		`--remote-debugging-port=${CDP_PORT}`,
		'--no-sandbox',
		'--disable-gpu',
		'--disable-dev-shm-usage',
		'--no-first-run',
		'--disable-extensions',
		'about:blank',
	],
	{ stdio: ['ignore', 'pipe', 'pipe'] }
)

// Wait for Chrome to be ready
await new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error('Chrome startup timeout')), 10000)
	const check = async () => {
		try {
			const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
			if (resp.ok) {
				clearTimeout(timeout)
				resolve()
				return
			}
		} catch {}
		setTimeout(check, 200)
	}
	check()
})
console.log('Chromium started with CDP')

// ─── Get the WebSocket URL ───
const versionResp = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
const versionData = await versionResp.json()
const wsUrl = versionData.webSocketDebuggerUrl
console.log(`CDP WebSocket: ${wsUrl}`)

// ═══════════════════════════════════════════
// TEST 1: CdpClient basic connectivity
// ═══════════════════════════════════════════
console.log('\n── Test 1: CdpClient ──')

const cdp = new CdpClient(`ws://127.0.0.1:${CDP_PORT}`)
await cdp.connect()
assert(true, 'CdpClient connected')

const targets = await cdp.send('Target.getTargets')
assert(targets.targetInfos.length > 0, 'Got browser targets')

await cdp.close()
assert(true, 'CdpClient closed cleanly')

// ═══════════════════════════════════════════
// TEST 2: RemotePageController - connect & navigate
// ═══════════════════════════════════════════
console.log('\n── Test 2: RemotePageController connect & navigate ──')

const controller = new RemotePageController({
	cdpUrl: `ws://127.0.0.1:${CDP_PORT}`,
	viewport: { width: 1280, height: 720 },
})
await controller.connect()
assert(true, 'RemotePageController connected')

await controller.navigate(`http://127.0.0.1:${HTTP_PORT}/`)
assert(true, 'Navigated to test page')

const url = await controller.getCurrentUrl()
assertIncludes(url, `127.0.0.1:${HTTP_PORT}`, `getCurrentUrl returned: ${url}`)

// ═══════════════════════════════════════════
// TEST 3: getBrowserState
// ═══════════════════════════════════════════
console.log('\n── Test 3: getBrowserState ──')

const state = await controller.getBrowserState()
assert(state.url.includes(`${HTTP_PORT}`), `BrowserState.url: ${state.url}`)
assert(state.title === 'Connector Test Page', `BrowserState.title: ${state.title}`)
assertIncludes(state.header, 'Current Page:', 'Header has page info')
assertIncludes(state.header, 'viewport', 'Header has viewport info')
assert(state.content.length > 10, `Content length: ${state.content.length}`)
assertIncludes(state.content, 'button', 'Content has button element')
assertIncludes(state.content, 'input', 'Content has input element')
assertIncludes(state.content, 'select', 'Content has select element')

console.log('\n  Content preview:')
state.content
	.split('\n')
	.slice(0, 10)
	.forEach((l) => console.log(`    ${l}`))

// ═══════════════════════════════════════════
// TEST 4: clickElement
// ═══════════════════════════════════════════
console.log('\n── Test 4: clickElement ──')

// Find the button index from content
const buttonLine = state.content.split('\n').find((l) => l.includes('Click Me'))
const buttonIndex = buttonLine ? parseInt(buttonLine.match(/\[(\d+)\]/)?.[1]) : 0
console.log(`  Button index: ${buttonIndex} (from: ${buttonLine?.trim()})`)

const clickResult = await controller.clickElement(buttonIndex)
assert(clickResult.success, `clickElement: ${clickResult.message}`)

// Verify the click effect
const outputCheck = await controller.executeJavascript(
	'return document.getElementById("output").textContent'
)
assert(outputCheck.success, `JS execution: ${outputCheck.message}`)
assertIncludes(outputCheck.message, 'clicked!', 'Button click updated DOM')

// ═══════════════════════════════════════════
// TEST 5: inputText
// ═══════════════════════════════════════════
console.log('\n── Test 5: inputText ──')

const inputLine = state.content
	.split('\n')
	.find((l) => l.includes('input') && l.includes('Type here'))
const inputIndex = inputLine ? parseInt(inputLine.match(/\[(\d+)\]/)?.[1]) : 1
console.log(`  Input index: ${inputIndex} (from: ${inputLine?.trim()})`)

const inputResult = await controller.inputText(inputIndex, 'Hello Autotask!')
assert(inputResult.success, `inputText: ${inputResult.message}`)

// Verify
const inputCheck = await controller.executeJavascript(
	'return document.getElementById("input1").value'
)
assertIncludes(inputCheck.message, 'Hello Autotask!', 'Input value was set')

// ═══════════════════════════════════════════
// TEST 6: selectOption
// ═══════════════════════════════════════════
console.log('\n── Test 6: selectOption ──')

const selectLine = state.content.split('\n').find((l) => l.includes('select'))
const selectIndex = selectLine ? parseInt(selectLine.match(/\[(\d+)\]/)?.[1]) : 2
console.log(`  Select index: ${selectIndex} (from: ${selectLine?.trim()})`)

const selectResult = await controller.selectOption(selectIndex, 'Option B')
assert(selectResult.success, `selectOption: ${selectResult.message}`)

const selectCheck = await controller.executeJavascript(
	'return document.getElementById("select1").value'
)
assertIncludes(selectCheck.message, 'b', 'Select value changed to b')

// ═══════════════════════════════════════════
// TEST 7: scroll
// ═══════════════════════════════════════════
console.log('\n── Test 7: scroll ──')

const scrollResult = await controller.scroll({ down: true, numPages: 1 })
assert(scrollResult.success, `scroll: ${scrollResult.message}`)

// Check scroll position changed
const scrollCheck = await controller.executeJavascript('return window.scrollY')
assertIncludes(scrollCheck.message, 'Result:', 'Scroll position readable')

// ═══════════════════════════════════════════
// TEST 8: updateTree after DOM change
// ═══════════════════════════════════════════
console.log('\n── Test 8: updateTree after DOM change ──')

// Add a new button dynamically
await controller.executeJavascript(`
	var btn = document.createElement('button');
	btn.textContent = 'Dynamic Button';
	btn.id = 'dynamic-btn';
	document.body.appendChild(btn);
`)

const newState = await controller.getBrowserState()
assertIncludes(newState.content, 'Dynamic Button', 'New dynamic element detected in tree')

// ═══════════════════════════════════════════
// TEST 9: cookie injection
// ═══════════════════════════════════════════
console.log('\n── Test 9: cookie injection ──')

await controller.injectCookies([
	{ name: 'test_session', value: 'abc123', domain: '127.0.0.1', path: '/' },
	{ name: 'auth_token', value: 'xyz789', domain: '127.0.0.1', path: '/' },
])

const cookieCheck = await controller.executeJavascript('return document.cookie')
assertIncludes(cookieCheck.message, 'test_session=abc123', 'Cookie test_session injected')
assertIncludes(cookieCheck.message, 'auth_token=xyz789', 'Cookie auth_token injected')

// ═══════════════════════════════════════════
// TEST 10: no-op methods (mask, highlights)
// ═══════════════════════════════════════════
console.log('\n── Test 10: no-op methods ──')

await controller.showMask()
assert(true, 'showMask() no-op succeeded')

await controller.hideMask()
assert(true, 'hideMask() no-op succeeded')

await controller.cleanUpHighlights()
assert(true, 'cleanUpHighlights() no-op succeeded')

const lastUpdate = await controller.getLastUpdateTime()
assert(lastUpdate > 0, `getLastUpdateTime: ${lastUpdate}`)

// ═══════════════════════════════════════════
// TEST 11: executeJavascript
// ═══════════════════════════════════════════
console.log('\n── Test 11: executeJavascript ──')

const jsResult = await controller.executeJavascript('return 2 + 2')
assert(jsResult.success, `executeJavascript: ${jsResult.message}`)
assertIncludes(jsResult.message, '4', 'JS returned correct result')

const jsAsyncResult = await controller.executeJavascript(
	'return await new Promise(r => setTimeout(() => r("async-ok"), 50))'
)
assert(jsAsyncResult.success, `async JS: ${jsAsyncResult.message}`)
assertIncludes(jsAsyncResult.message, 'async-ok', 'Async JS returned correct result')

// ═══════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════
console.log('\n── Cleanup ──')

controller.dispose()
assert(true, 'Controller disposed')

chrome.kill()
httpServer.close()

console.log(`\n${'═'.repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
console.log(`${'═'.repeat(40)}`)

process.exit(failed > 0 ? 1 : 0)
