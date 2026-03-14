/**
 * Minimal CDP (Chrome DevTools Protocol) client over WebSocket.
 * Works with any CDP-compatible browser: Chrome, Chromium, Lightpanda, etc.
 */
import { EventEmitter } from 'node:events'

interface CdpResponse {
	id: number
	result?: any
	error?: { code: number; message: string; data?: string }
}

interface CdpEvent {
	method: string
	params?: any
}

export class CdpClient extends EventEmitter {
	private ws: WebSocket | null = null
	private nextId = 1
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
	private wsUrl: string

	constructor(wsUrl: string) {
		super()
		this.wsUrl = wsUrl
	}

	/**
	 * Connect to a CDP page target.
	 * Discovers available page targets via /json HTTP endpoint, picks the first one,
	 * and connects to its WebSocket debugger URL.
	 * If no page target exists, creates one via /json/new.
	 */
	async connect(): Promise<void> {
		// Derive HTTP URL from ws:// URL for discovery
		const httpBase = this.wsUrl.replace(/^ws:\/\//, 'http://').replace(/\/$/, '')

		// Find or create a page target
		let wsEndpoint: string
		try {
			// List available targets
			const listResp = await fetch(`${httpBase}/json/list`)
			const targets = (await listResp.json()) as {
				type: string
				webSocketDebuggerUrl?: string
			}[]

			// Find a page target
			const pageTarget = targets.find((t) => t.type === 'page')

			if (pageTarget?.webSocketDebuggerUrl) {
				wsEndpoint = pageTarget.webSocketDebuggerUrl
			} else {
				// Create a new page target
				try {
					const newResp = await fetch(`${httpBase}/json/new?about:blank`)
					const newTarget = (await newResp.json()) as { webSocketDebuggerUrl?: string }
					wsEndpoint = newTarget.webSocketDebuggerUrl || this.wsUrl
				} catch {
					// Fall back to browser-level endpoint
					const versionResp = await fetch(`${httpBase}/json/version`)
					const versionData = (await versionResp.json()) as {
						webSocketDebuggerUrl?: string
					}
					wsEndpoint = versionData.webSocketDebuggerUrl || this.wsUrl
				}
			}
		} catch {
			// If all discovery fails, try direct connection
			wsEndpoint = this.wsUrl
		}

		return this.connectToWebSocket(wsEndpoint)
	}

	/**
	 * Connect directly to a specific WebSocket URL.
	 */
	private connectToWebSocket(wsEndpoint: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.ws = new WebSocket(wsEndpoint)

			this.ws.addEventListener('open', () => resolve())
			this.ws.addEventListener('error', (e) =>
				reject(new Error(`CDP WebSocket error: ${(e as ErrorEvent).message || 'unknown'}`))
			)

			this.ws.addEventListener('message', (event) => {
				const data = JSON.parse(String(event.data)) as CdpResponse & CdpEvent
				if (data.id !== undefined) {
					// Response to a command
					const handler = this.pending.get(data.id)
					if (handler) {
						this.pending.delete(data.id)
						if (data.error) {
							handler.reject(new Error(`CDP error: ${data.error.message}`))
						} else {
							handler.resolve(data.result)
						}
					}
				} else if (data.method) {
					// CDP event
					this.emit(data.method, data.params)
				}
			})

			this.ws.addEventListener('close', () => {
				// Reject all pending requests
				for (const [, handler] of this.pending) {
					handler.reject(new Error('CDP connection closed'))
				}
				this.pending.clear()
				this.emit('close')
			})
		})
	}

	/**
	 * Send a CDP command and wait for the response.
	 */
	async send(method: string, params?: Record<string, unknown>): Promise<any> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('CDP WebSocket not connected')
		}

		const id = this.nextId++
		const message = JSON.stringify({ id, method, params })

		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject })
			this.ws!.send(message)
		})
	}

	/**
	 * Close the CDP connection.
	 */
	async close(): Promise<void> {
		if (this.ws) {
			this.ws.close()
			this.ws = null
		}
	}
}
