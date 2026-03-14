/**
 * RemotePageController — drop-in replacement for PageController that operates
 * over CDP against a headless browser (Lightpanda, Chrome, etc).
 *
 * Implements the same interface that PageAgentCore expects from PageController,
 * so you can pass it directly: new PageAgentCore({ pageController: remote, ... })
 */
import { EventEmitter } from 'node:events'

import { CdpClient } from './CdpClient'
import { getInjectionScript } from './inject'
import type { ConnectorConfig, CookieSpec } from './types'

interface ActionResult {
	success: boolean
	message: string
}

interface BrowserState {
	url: string
	title: string
	header: string
	content: string
	footer: string
}

export class RemotePageController extends EventEmitter {
	private cdp: CdpClient
	private config: ConnectorConfig
	private lastUpdateTime = 0
	private injected = false

	constructor(config: ConnectorConfig = {}) {
		super()
		this.config = config
		this.cdp = new CdpClient(config.cdpUrl || 'ws://localhost:9222')
	}

	/**
	 * Connect to the headless browser via CDP.
	 * Optionally injects cookies and navigates to the initial URL.
	 */
	async connect(): Promise<void> {
		await this.cdp.connect()

		// Enable required CDP domains
		await this.cdp.send('Page.enable')
		await this.cdp.send('Runtime.enable')

		// Try enabling Network domain for cookie injection
		try {
			await this.cdp.send('Network.enable')
		} catch {
			// Network domain may not be available in all browsers
		}

		// Inject cookies before navigation
		if (this.config.cookies?.length) {
			await this.injectCookies(this.config.cookies)
		}

		// Navigate to initial URL if provided
		if (this.config.url) {
			await this.navigate(this.config.url)
		}
	}

	/**
	 * Navigate to a URL and wait for it to load.
	 */
	async navigate(url: string): Promise<void> {
		this.injected = false
		await this.cdp.send('Page.navigate', { url })
		// Wait for load event
		await this.waitForLoad()
		await this.ensureInjected()
	}

	/**
	 * Inject authentication cookies via CDP.
	 * Falls back to document.cookie if Network.setCookie is unavailable.
	 */
	async injectCookies(cookies: CookieSpec[]): Promise<void> {
		for (const cookie of cookies) {
			try {
				await this.cdp.send('Network.setCookie', {
					name: cookie.name,
					value: cookie.value,
					domain: cookie.domain,
					path: cookie.path || '/',
					secure: cookie.secure ?? false,
					httpOnly: cookie.httpOnly ?? false,
					sameSite: cookie.sameSite,
					expires: cookie.expires,
				})
			} catch {
				// Fallback: inject via document.cookie (won't work for httpOnly cookies)
				const parts = [`${cookie.name}=${cookie.value}`]
				if (cookie.path) parts.push(`path=${cookie.path}`)
				if (cookie.domain) parts.push(`domain=${cookie.domain}`)
				if (cookie.secure) parts.push('secure')
				if (cookie.sameSite) parts.push(`SameSite=${cookie.sameSite}`)
				if (cookie.expires) parts.push(`expires=${new Date(cookie.expires * 1000).toUTCString()}`)
				await this.evaluate(`document.cookie = ${JSON.stringify(parts.join('; '))}`)
			}
		}
	}

	// ======= PageController interface =======

	async getCurrentUrl(): Promise<string> {
		const result = await this.evaluate('window.location.href')
		return result as string
	}

	async getLastUpdateTime(): Promise<number> {
		return this.lastUpdateTime
	}

	async getBrowserState(): Promise<BrowserState> {
		await this.ensureInjected()
		const result = await this.evaluateAsync(
			'JSON.stringify(await window.__pageAgent.getBrowserState())'
		)
		return JSON.parse(result as string)
	}

	async updateTree(): Promise<string> {
		await this.ensureInjected()
		this.lastUpdateTime = Date.now()
		const result = await this.evaluateAsync('JSON.stringify(await window.__pageAgent.updateTree())')
		return JSON.parse(result as string)
	}

	async cleanUpHighlights(): Promise<void> {
		// No-op in headless mode — highlights are visual-only
	}

	async clickElement(index: number): Promise<ActionResult> {
		await this.ensureInjected()
		const result = await this.evaluateAsync(
			`JSON.stringify(await window.__pageAgent.clickElement(${index}))`
		)
		return JSON.parse(result as string)
	}

	async inputText(index: number, text: string): Promise<ActionResult> {
		await this.ensureInjected()
		const escaped = JSON.stringify(text)
		const result = await this.evaluateAsync(
			`JSON.stringify(await window.__pageAgent.inputText(${index}, ${escaped}))`
		)
		return JSON.parse(result as string)
	}

	async selectOption(index: number, optionText: string): Promise<ActionResult> {
		await this.ensureInjected()
		const escaped = JSON.stringify(optionText)
		const result = await this.evaluateAsync(
			`JSON.stringify(await window.__pageAgent.selectOption(${index}, ${escaped}))`
		)
		return JSON.parse(result as string)
	}

	async scroll(options: {
		down: boolean
		numPages: number
		pixels?: number
		index?: number
	}): Promise<ActionResult> {
		await this.ensureInjected()
		const result = await this.evaluateAsync(
			`JSON.stringify(await window.__pageAgent.scroll(${JSON.stringify(options)}))`
		)
		return JSON.parse(result as string)
	}

	async scrollHorizontally(options: {
		right: boolean
		pixels: number
		index?: number
	}): Promise<ActionResult> {
		await this.ensureInjected()
		const result = await this.evaluateAsync(
			`JSON.stringify(await window.__pageAgent.scrollHorizontally(${JSON.stringify(options)}))`
		)
		return JSON.parse(result as string)
	}

	async executeJavascript(script: string): Promise<ActionResult> {
		await this.ensureInjected()
		const escaped = JSON.stringify(script)
		const result = await this.evaluateAsync(
			`JSON.stringify(await window.__pageAgent.executeJavascript(${escaped}))`
		)
		return JSON.parse(result as string)
	}

	async showMask(): Promise<void> {
		// No-op in headless mode
	}

	async hideMask(): Promise<void> {
		// No-op in headless mode
	}

	dispose(): void {
		this.cdp.close()
	}

	// ======= Internal helpers =======

	/**
	 * Ensure the injection script has been loaded into the current page.
	 */
	private async ensureInjected(): Promise<void> {
		if (this.injected) return
		const script = getInjectionScript(this.config.viewport)
		await this.evaluate(script)
		this.injected = true

		// Auto-re-inject on navigation
		try {
			await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script })
		} catch {
			// Not all CDP implementations support this — we'll re-inject manually
			this.cdp.on('Page.frameNavigated', () => {
				this.injected = false
			})
		}
	}

	/**
	 * Evaluate a synchronous JS expression in the page context.
	 */
	private async evaluate(expression: string): Promise<unknown> {
		const result = await this.cdp.send('Runtime.evaluate', {
			expression,
			returnByValue: true,
		})
		if (result?.exceptionDetails) {
			throw new Error(`JS evaluation error: ${result.exceptionDetails.text}`)
		}
		return result?.result?.value
	}

	/**
	 * Evaluate an async JS expression (returns a promise) in the page context.
	 */
	private async evaluateAsync(expression: string): Promise<unknown> {
		const result = await this.cdp.send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true,
		})
		if (result?.exceptionDetails) {
			throw new Error(`JS evaluation error: ${result.exceptionDetails.text}`)
		}
		return result?.result?.value
	}

	/**
	 * Wait for the page load event.
	 */
	private waitForLoad(): Promise<void> {
		return new Promise((resolve) => {
			const onLoad = () => {
				this.cdp.removeListener('Page.loadEventFired', onLoad)
				resolve()
			}
			this.cdp.on('Page.loadEventFired', onLoad)

			// Timeout fallback — some pages don't fire load event cleanly
			setTimeout(() => {
				this.cdp.removeListener('Page.loadEventFired', onLoad)
				resolve()
			}, 10000)
		})
	}
}
