/**
 * Configuration for connecting to a CDP-compatible headless browser.
 */
export interface ConnectorConfig {
	/** CDP WebSocket endpoint URL (default: ws://localhost:9222) */
	cdpUrl?: string
	/** Initial URL to navigate to after connecting */
	url?: string
	/** Cookies to inject before navigation (for auth session transfer) */
	cookies?: CookieSpec[]
	/** Viewport dimensions — used for page info calculations in headless mode */
	viewport?: { width: number; height: number }
}

/**
 * Cookie specification for session/auth injection via CDP Network.setCookie.
 * Mirrors the CDP Network.CookieParam type.
 */
export interface CookieSpec {
	name: string
	value: string
	domain: string
	path?: string
	secure?: boolean
	httpOnly?: boolean
	sameSite?: 'Strict' | 'Lax' | 'None'
	/** Unix timestamp in seconds */
	expires?: number
}
