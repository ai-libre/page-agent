/**
 * Script to be injected into the headless browser page via CDP Runtime.evaluate.
 *
 * This script creates a global __pageAgent object that wraps the page-controller's
 * PageController class, providing JSON-serializable methods that RemotePageController
 * calls via CDP.
 *
 * The page-controller package is imported at build time — this module exports the
 * script as a string constant for injection.
 */

/**
 * Returns the injection script as a string.
 * The script expects @page-agent/page-controller to already be available in the page
 * (injected separately as a bundle), OR it bootstraps a minimal equivalent inline.
 *
 * For simplicity and to avoid complex bundling, we inline a self-contained version
 * that imports the page-controller constructor and wraps it.
 */
export function getInjectionScript(viewport?: { width: number; height: number }): string {
	const vw = viewport?.width ?? 1280
	const vh = viewport?.height ?? 720

	// This script runs inside the headless browser's page context.
	// It creates a PageController instance and exposes a __pageAgent global
	// with JSON-serializable async methods.
	return `
(function() {
	if (window.__pageAgent) return;

	// Mock viewport dimensions if not set by the browser
	if (window.innerWidth === 0 || window.innerHeight === 0) {
		Object.defineProperty(window, 'innerWidth', { value: ${vw}, writable: true });
		Object.defineProperty(window, 'innerHeight', { value: ${vh}, writable: true });
	}

	// ---- Minimal PageController state ----
	var flatTree = null;
	var selectorMap = new Map();
	var elementTextMap = new Map();
	var simplifiedHTML = '<EMPTY>';
	var lastTimeUpdate = 0;
	var isIndexed = false;

	// ---- Expose the bridge ----
	window.__pageAgent = {
		getBrowserState: async function() {
			await this.updateTree();

			var url = window.location.href;
			var title = document.title;

			var vw = window.innerWidth;
			var vh = window.innerHeight;
			var pw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth || 0);
			var ph = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight || 0);
			var sy = window.scrollY || 0;
			var pixelsBelow = Math.max(0, ph - (vh + sy));
			var pagesAbove = vh > 0 ? sy / vh : 0;
			var pagesBelow = vh > 0 ? pixelsBelow / vh : 0;
			var totalPages = vh > 0 ? ph / vh : 0;
			var pos = sy / Math.max(1, ph - vh);

			var titleLine = 'Current Page: [' + title + '](' + url + ')';
			var pageInfoLine = 'Page info: ' + vw + 'x' + vh + 'px viewport, ' +
				pw + 'x' + ph + 'px total page size, ' +
				pagesAbove.toFixed(1) + ' pages above, ' +
				pagesBelow.toFixed(1) + ' pages below, ' +
				totalPages.toFixed(1) + ' total pages, at ' +
				(pos * 100).toFixed(0) + '% of page';

			var elementsLabel = 'Interactive elements from top layer of the current page (full page):';
			var hasAbove = sy > 4;
			var scrollHintAbove = hasAbove ? '... ' + sy + ' pixels above (' + pagesAbove.toFixed(1) + ' pages) - scroll to see more ...' : '[Start of page]';

			var header = titleLine + '\\n' + pageInfoLine + '\\n\\n' + elementsLabel + '\\n\\n' + scrollHintAbove;

			var hasBelow = pixelsBelow > 4;
			var footer = hasBelow ? '... ' + pixelsBelow + ' pixels below (' + pagesBelow.toFixed(1) + ' pages) - scroll to see more ...' : '[End of page]';

			return { url: url, title: title, header: header, content: simplifiedHTML, footer: footer };
		},

		updateTree: async function() {
			lastTimeUpdate = Date.now();

			// Use the injected page-controller if available
			if (window.__pageController) {
				simplifiedHTML = await window.__pageController.updateTree();
				isIndexed = true;
				return simplifiedHTML;
			}

			// Fallback: basic interactive element extraction
			var elements = [];
			var idx = 0;
			var interactiveSelectors = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"], [onclick], [tabindex]';
			var allInteractive = document.querySelectorAll(interactiveSelectors);

			selectorMap.clear();
			elementTextMap.clear();

			for (var i = 0; i < allInteractive.length; i++) {
				var el = allInteractive[i];
				// Skip hidden elements
				if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') continue;
				var rect = el.getBoundingClientRect();
				if (rect.width === 0 && rect.height === 0) continue;

				var tag = el.tagName.toLowerCase();
				var attrs = '';
				var attrNames = ['type', 'role', 'name', 'placeholder', 'aria-label', 'value', 'href', 'title', 'id'];
				for (var a = 0; a < attrNames.length; a++) {
					var v = el.getAttribute(attrNames[a]);
					if (v && v.length > 0) {
						var truncated = v.length > 20 ? v.substring(0, 20) + '...' : v;
						attrs += ' ' + attrNames[a] + '=' + truncated;
					}
				}

				var text = (el.textContent || '').trim().substring(0, 50);
				var line = '[' + idx + ']<' + tag + attrs + '>' + text + ' />';
				elements.push(line);

				selectorMap.set(idx, el);
				elementTextMap.set(idx, line);
				idx++;
			}

			simplifiedHTML = elements.join('\\n');
			isIndexed = true;
			return simplifiedHTML;
		},

		getLastUpdateTime: function() {
			return lastTimeUpdate;
		},

		clickElement: async function(index) {
			if (!isIndexed) return { success: false, message: 'DOM not indexed yet' };
			var el = selectorMap.get(index);
			if (!el) return { success: false, message: 'Element not found at index ' + index };

			try {
				el.scrollIntoView({ block: 'center', inline: 'nearest' });
				el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
				el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
				el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
				el.focus();
				el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
				el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

				var desc = elementTextMap.get(index) || String(index);
				if (el.tagName === 'A' && el.target === '_blank') {
					return { success: true, message: 'Clicked element (' + desc + '). Link opened in a new tab.' };
				}
				return { success: true, message: 'Clicked element (' + desc + ').' };
			} catch (e) {
				return { success: false, message: 'Failed to click element: ' + e };
			}
		},

		inputText: async function(index, text) {
			if (!isIndexed) return { success: false, message: 'DOM not indexed yet' };
			var el = selectorMap.get(index);
			if (!el) return { success: false, message: 'Element not found at index ' + index };

			try {
				// Click first
				await this.clickElement(index);

				if (el.isContentEditable) {
					el.innerText = '';
					el.innerText = text;
					el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				} else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
					// Use native setter to trigger React/Vue/Angular change detection
					var nativeSetter = Object.getOwnPropertyDescriptor(
						el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
						'value'
					);
					if (nativeSetter && nativeSetter.set) {
						nativeSetter.set.call(el, text);
					} else {
						el.value = text;
					}
					el.dispatchEvent(new Event('input', { bubbles: true }));
				}
				el.dispatchEvent(new Event('change', { bubbles: true }));

				return { success: true, message: 'Input text (' + text + ') into element.' };
			} catch (e) {
				return { success: false, message: 'Failed to input text: ' + e };
			}
		},

		selectOption: async function(index, optionText) {
			if (!isIndexed) return { success: false, message: 'DOM not indexed yet' };
			var el = selectorMap.get(index);
			if (!el) return { success: false, message: 'Element not found at index ' + index };

			try {
				if (el.tagName !== 'SELECT') {
					return { success: false, message: 'Element is not a select element' };
				}
				var options = Array.from(el.options);
				var option = options.find(function(opt) { return (opt.textContent || '').trim() === optionText.trim(); });
				if (!option) {
					return { success: false, message: 'Option "' + optionText + '" not found' };
				}
				el.value = option.value;
				el.dispatchEvent(new Event('change', { bubbles: true }));
				return { success: true, message: 'Selected option (' + optionText + ').' };
			} catch (e) {
				return { success: false, message: 'Failed to select option: ' + e };
			}
		},

		scroll: async function(options) {
			try {
				var down = options.down !== false;
				var amount = options.pixels || (options.numPages || 1) * window.innerHeight;
				var dy = down ? amount : -amount;

				if (options.index !== undefined) {
					var el = selectorMap.get(options.index);
					if (el) {
						el.scrollBy(0, dy);
						return { success: true, message: 'Scrolled element by ' + dy + 'px.' };
					}
				}

				var before = window.scrollY;
				window.scrollBy(0, dy);
				var after = window.scrollY;
				var scrolled = after - before;

				if (Math.abs(scrolled) < 1) {
					return { success: true, message: down ? 'Already at the bottom of the page.' : 'Already at the top of the page.' };
				}
				return { success: true, message: 'Scrolled page by ' + scrolled + 'px.' };
			} catch (e) {
				return { success: false, message: 'Failed to scroll: ' + e };
			}
		},

		scrollHorizontally: async function(options) {
			try {
				var right = options.right !== false;
				var dx = right ? options.pixels : -options.pixels;

				if (options.index !== undefined) {
					var el = selectorMap.get(options.index);
					if (el) {
						el.scrollBy(dx, 0);
						return { success: true, message: 'Scrolled element horizontally by ' + dx + 'px.' };
					}
				}

				var before = window.scrollX;
				window.scrollBy(dx, 0);
				var after = window.scrollX;
				var scrolled = after - before;

				if (Math.abs(scrolled) < 1) {
					return { success: true, message: right ? 'Already at the right edge.' : 'Already at the left edge.' };
				}
				return { success: true, message: 'Scrolled page horizontally by ' + scrolled + 'px.' };
			} catch (e) {
				return { success: false, message: 'Failed to scroll horizontally: ' + e };
			}
		},

		executeJavascript: async function(script) {
			try {
				var fn = new Function('return (async () => { ' + script + ' })()');
				var result = await fn();
				return { success: true, message: 'Executed JavaScript. Result: ' + result };
			} catch (e) {
				return { success: false, message: 'Error executing JavaScript: ' + e };
			}
		}
	};
})();
`
}
