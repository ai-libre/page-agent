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
	 * Connect to the CDP endpoint.
	 * Discovers the debugger WebSocket URL via the /json/version HTTP endpoint,
	 * then opens a WebSocket connection.
	 */
	async connect(): Promise<void> {
		// Derive HTTP URL from ws:// URL for discovery
		const httpBase = this.wsUrl.replace(/^ws:\/\//, 'http://').replace(/\/$/, '')

		// Try to get the debugger WebSocket URL
		let wsEndpoint: string
		try {
			const resp = await fetch(`${httpBase}/json/version`)
			const data = (await resp.json()) as { webSocketDebuggerUrl?: string }
			wsEndpoint = data.webSocketDebuggerUrl || this.wsUrl
		} catch {
			// If discovery fails, try direct connection
			wsEndpoint = this.wsUrl
		}

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
