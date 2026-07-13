// server.js - Complete Reverse Proxy Server
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// MIME types for serving static files
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.otf': 'font/otf'
};

// Create the server
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    
    // Handle proxy requests
    if (pathname === '/proxy') {
        handleProxyRequest(req, res, parsedUrl);
        return;
    }
    
    // Serve the main UI
    if (pathname === '/' || pathname === '/index.html') {
        serveUI(req, res);
        return;
    }
    
    // 404 for any other routes
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

function handleProxyRequest(req, res, parsedUrl) {
    const targetUrl = parsedUrl.query.url;
    
    if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'URL parameter is required' }));
        return;
    }
    
    let targetParsed;
    try {
        targetParsed = url.parse(targetUrl);
        if (!targetParsed.protocol) {
            targetParsed = url.parse('https://' + targetUrl);
        }
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid URL' }));
        return;
    }
    
    if (!targetParsed.hostname) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid URL: missing hostname' }));
        return;
    }
    
    const protocol = targetParsed.protocol === 'https:' ? https : http;
    const options = {
        hostname: targetParsed.hostname,
        port: targetParsed.port || (targetParsed.protocol === 'https:' ? 443 : 80),
        path: targetParsed.path,
        method: req.method,
        headers: {
            ...req.headers,
            host: targetParsed.hostname,
            referer: targetParsed.href,
            origin: targetParsed.protocol + '//' + targetParsed.hostname
        }
    };
    
    // Remove hop-by-hop headers
    delete options.headers['proxy-connection'];
    delete options.headers['proxy-authorization'];
    delete options.headers['proxy-authenticate'];
    
    const proxyReq = protocol.request(options, (proxyRes) => {
        // Handle redirects
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
            let location = proxyRes.headers.location;
            try {
                // Resolve relative URLs
                if (!location.startsWith('http')) {
                    const baseUrl = targetParsed.protocol + '//' + targetParsed.hostname;
                    location = new url.URL(location, baseUrl).href;
                }
                location = '/proxy?url=' + encodeURIComponent(location);
            } catch (e) {
                location = '/proxy?url=' + encodeURIComponent(location);
            }
            res.writeHead(proxyRes.statusCode, { 'Location': location });
            res.end();
            return;
        }
        
        // Set response headers
        const responseHeaders = { ...proxyRes.headers };
        
        // Modify content-type for HTML to inject our proxy script
        const contentType = proxyRes.headers['content-type'] || '';
        const isHTML = contentType.includes('text/html');
        
        if (isHTML) {
            delete responseHeaders['content-length']; // Will be modified
        }
        
        // Remove security headers that might cause issues
        delete responseHeaders['x-frame-options'];
        delete responseHeaders['content-security-policy'];
        delete responseHeaders['x-content-security-policy'];
        delete responseHeaders['x-webkit-csp'];
        
        // Set CORS headers
        responseHeaders['access-control-allow-origin'] = '*';
        responseHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
        responseHeaders['access-control-allow-headers'] = '*';
        
        res.writeHead(proxyRes.statusCode, responseHeaders);
        
        if (isHTML) {
            let body = '';
            proxyRes.on('data', (chunk) => {
                body += chunk.toString();
            });
            
            proxyRes.on('end', () => {
                // Inject base tag and proxy script
                body = injectProxyScript(body, targetUrl);
                res.end(body);
            });
        } else {
            proxyRes.pipe(res);
        }
    });
    
    proxyReq.on('error', (err) => {
        console.error('Proxy error:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to fetch URL: ' + err.message }));
    });
    
    // Handle request body for POST/PUT etc.
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        req.pipe(proxyReq);
    } else {
        proxyReq.end();
    }
}

function injectProxyScript(html, originalUrl) {
    const proxyScript = `
    <script>
    (function() {
        // Rewrite all links to go through proxy
        function rewriteURL(url) {
            if (!url || url.startsWith('#') || url.startsWith('javascript:') || 
                url.startsWith('data:') || url.startsWith('mailto:') || 
                url.startsWith('blob:')) {
                return url;
            }
            try {
                const absolute = new URL(url, window.location.href);
                return '/proxy?url=' + encodeURIComponent(absolute.href);
            } catch(e) {
                return url;
            }
        }
        
        // Override history API
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;
        
        history.pushState = function(state, title, url) {
            if (url) url = rewriteURL(url);
            return originalPushState.call(this, state, title, url);
        };
        
        history.replaceState = function(state, title, url) {
            if (url) url = rewriteURL(url);
            return originalReplaceState.call(this, state, title, url);
        };
        
        // Override window.open
        const originalOpen = window.open;
        window.open = function(url, target, features) {
            if (url) url = rewriteURL(url);
            return originalOpen.call(this, url, target, features);
        };
        
        // Process all links periodically and on DOM changes
        function processLinks() {
            const elements = document.querySelectorAll('a[href], form[action], link[href], script[src], img[src], iframe[src], source[src], video[src], audio[src], embed[src], object[data], area[href]');
            
            elements.forEach(el => {
                const attrs = ['href', 'action', 'src', 'data'];
                attrs.forEach(attr => {
                    if (el.hasAttribute(attr)) {
                        const val = el.getAttribute(attr);
                        if (val && !val.startsWith('/proxy?') && !val.startsWith('#')) {
                            el.setAttribute(attr, rewriteURL(val));
                        }
                    }
                });
            });
        }
        
        // Handle dynamic content
        const observer = new MutationObserver(processLinks);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href', 'src', 'action', 'data']
        });
        
        // Initial processing
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', processLinks);
        } else {
            processLinks();
        }
        
        // Periodic processing for safety
        setInterval(processLinks, 2000);
    })();
    </script>`;
    
    // Remove existing base tags
    let modified = html.replace(/<base[^>]*>/gi, '');
    
    // Add base tag to help with relative URLs
    const baseTag = `<base href="${originalUrl}">`;
    
    // Insert base tag and script before closing head tag
    if (modified.includes('</head>')) {
        modified = modified.replace('</head>', `${baseTag}\n${proxyScript}\n</head>`);
    } else if (modified.includes('<head>')) {
        modified = modified.replace('<head>', `<head>\n${baseTag}\n${proxyScript}`);
    } else if (modified.includes('<html>')) {
        modified = modified.replace('<html>', `<html>\n<head>\n${baseTag}\n${proxyScript}\n</head>`);
    } else {
        modified = baseTag + proxyScript + modified;
    }
    
    return modified;
}

function serveUI(req, res) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proxy Browser</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: #0a0a0f;
            color: #e0e0e0;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        
        .toolbar {
            background: linear-gradient(180deg, #1a1a2e 0%, #16162a 100%);
            padding: 12px 16px;
            display: flex;
            gap: 10px;
            align-items: center;
            border-bottom: 1px solid #2a2a4a;
            box-shadow: 0 2px 20px rgba(0, 0, 0, 0.5);
            z-index: 1000;
        }
        
        .logo {
            font-size: 22px;
            font-weight: 700;
            background: linear-gradient(135deg, #6c5ce7, #a78bfa);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-right: 10px;
            white-space: nowrap;
        }
        
        .url-container {
            flex: 1;
            display: flex;
            gap: 8px;
        }
        
        .url-input {
            flex: 1;
            padding: 10px 16px;
            background: #0d0d1a;
            border: 1px solid #2a2a4a;
            border-radius: 12px;
            color: #e0e0e0;
            font-size: 14px;
            outline: none;
            transition: all 0.3s ease;
        }
        
        .url-input:focus {
            border-color: #6c5ce7;
            box-shadow: 0 0 0 3px rgba(108, 92, 231, 0.2);
        }
        
        .url-input::placeholder {
            color: #4a4a6a;
        }
        
        .btn {
            padding: 10px 20px;
            background: linear-gradient(135deg, #6c5ce7, #a78bfa);
            border: none;
            border-radius: 12px;
            color: white;
            font-weight: 600;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.3s ease;
            white-space: nowrap;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 15px rgba(108, 92, 231, 0.4);
        }
        
        .btn:active {
            transform: translateY(0);
        }
        
        .btn-secondary {
            background: #1a1a2e;
            border: 1px solid #2a2a4a;
        }
        
        .btn-secondary:hover {
            background: #222244;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
        }
        
        .btn-icon {
            font-size: 18px;
        }
        
        .iframe-container {
            flex: 1;
            position: relative;
            background: #0a0a0f;
        }
        
        .loading-overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(10, 10, 15, 0.9);
            z-index: 100;
            display: none;
        }
        
        .loading-overlay.active {
            display: flex;
        }
        
        .spinner {
            width: 50px;
            height: 50px;
            border: 3px solid #2a2a4a;
            border-top: 3px solid #6c5ce7;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        iframe {
            width: 100%;
            height: 100%;
            border: none;
            background: white;
        }
        
        .home-screen {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-direction: column;
        }
        
        .home-title {
            font-size: 48px;
            font-weight: 700;
            background: linear-gradient(135deg, #6c5ce7, #a78bfa);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 16px;
        }
        
        .home-subtitle {
            color: #4a4a6a;
            font-size: 18px;
            margin-bottom: 32px;
        }
        
        .quick-links {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 12px;
            max-width: 600px;
            width: 90%;
        }
        
        .quick-link {
            padding: 16px;
            background: #1a1a2e;
            border: 1px solid #2a2a4a;
            border-radius: 12px;
            color: #e0e0e0;
            text-align: center;
            cursor: pointer;
            transition: all 0.3s ease;
            font-size: 14px;
        }
        
        .quick-link:hover {
            background: #222244;
            border-color: #6c5ce7;
            transform: translateY(-2px);
            box-shadow: 0 4px 15px rgba(108, 92, 231, 0.2);
        }
        
        .quick-link-icon {
            font-size: 24px;
            margin-bottom: 8px;
            display: block;
        }
        
        .error-message {
            position: fixed;
            top: 80px;
            left: 50%;
            transform: translateX(-50%);
            background: #1a1a2e;
            border: 1px solid #ff4757;
            border-radius: 12px;
            padding: 12px 24px;
            color: #ff4757;
            font-size: 14px;
            z-index: 2000;
            display: none;
            animation: slideDown 0.3s ease;
        }
        
        .error-message.show {
            display: block;
        }
        
        @keyframes slideDown {
            from {
                transform: translateX(-50%) translateY(-20px);
                opacity: 0;
            }
            to {
                transform: translateX(-50%) translateY(0);
                opacity: 1;
            }
        }
        
        @media (max-width: 600px) {
            .toolbar {
                flex-wrap: wrap;
                padding: 8px;
            }
            
            .logo {
                font-size: 18px;
            }
            
            .url-input {
                font-size: 12px;
                padding: 8px 12px;
            }
            
            .btn {
                padding: 8px 14px;
                font-size: 12px;
            }
            
            .home-title {
                font-size: 32px;
            }
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <div class="logo">Proxy</div>
        <div class="url-container">
            <input type="text" class="url-input" id="urlInput" placeholder="Enter URL to browse..." autofocus>
            <button class="btn" id="goBtn">
                <span class="btn-icon">→</span> Go
            </button>
        </div>
        <button class="btn btn-secondary" id="refreshBtn" title="Refresh">
            <span class="btn-icon">↻</span>
        </button>
        <button class="btn btn-secondary" id="homeBtn" title="Home">
            <span class="btn-icon">⌂</span>
        </button>
    </div>
    
    <div class="iframe-container" id="iframeContainer">
        <div class="home-screen" id="homeScreen">
            <div class="home-title">Proxy Browser</div>
            <div class="home-subtitle">Enter a URL above to get started</div>
            <div class="quick-links">
                <div class="quick-link" data-url="https://www.google.com">
                    <span class="quick-link-icon">🔍</span>
                    Google
                </div>
                <div class="quick-link" data-url="https://www.youtube.com">
                    <span class="quick-link-icon">▶️</span>
                    YouTube
                </div>
                <div class="quick-link" data-url="https://en.wikipedia.org">
                    <span class="quick-link-icon">📚</span>
                    Wikipedia
                </div>
                <div class="quick-link" data-url="https://github.com">
                    <span class="quick-link-icon">💻</span>
                    GitHub
                </div>
                <div class="quick-link" data-url="https://www.reddit.com">
                    <span class="quick-link-icon">💬</span>
                    Reddit
                </div>
                <div class="quick-link" data-url="https://news.ycombinator.com">
                    <span class="quick-link-icon">📰</span>
                    Hacker News
                </div>
            </div>
        </div>
        
        <iframe id="proxyFrame" sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-top-navigation" style="display:none;"></iframe>
        
        <div class="loading-overlay" id="loadingOverlay">
            <div class="spinner"></div>
        </div>
    </div>
    
    <div class="error-message" id="errorMessage"></div>
    
    <script>
        const urlInput = document.getElementById('urlInput');
        const goBtn = document.getElementById('goBtn');
        const refreshBtn = document.getElementById('refreshBtn');
        const homeBtn = document.getElementById('homeBtn');
        const proxyFrame = document.getElementById('proxyFrame');
        const homeScreen = document.getElementById('homeScreen');
        const loadingOverlay = document.getElementById('loadingOverlay');
        const errorMessage = document.getElementById('errorMessage');
        
        let currentUrl = '';
        
        function addHttps(url) {
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                return 'https://' + url;
            }
            return url;
        }
        
        function showError(msg) {
            errorMessage.textContent = msg;
            errorMessage.classList.add('show');
            setTimeout(() => {
                errorMessage.classList.remove('show');
            }, 3000);
        }
        
        function showLoading() {
            loadingOverlay.classList.add('active');
        }
        
        function hideLoading() {
            loadingOverlay.classList.remove('active');
        }
        
        function navigateTo(url) {
            url = addHttps(url.trim());
            const proxyUrl = '/proxy?url=' + encodeURIComponent(url);
            
            showLoading();
            currentUrl = url;
            urlInput.value = url;
            
            proxyFrame.src = proxyUrl;
            proxyFrame.style.display = 'block';
            homeScreen.style.display = 'none';
            
            // Hide loading when frame loads
            proxyFrame.onload = function() {
                hideLoading();
                try {
                    const frameUrl = proxyFrame.contentWindow.location.href;
                    if (frameUrl && frameUrl.includes('/proxy?url=')) {
                        const decoded = decodeURIComponent(frameUrl.split('/proxy?url=')[1]);
                        if (decoded && decoded !== 'about:blank') {
                            currentUrl = decoded;
                            urlInput.value = decoded;
                        }
                    }
                } catch(e) {
                    // Cross-origin, can't access
                }
            };
            
            proxyFrame.onerror = function() {
                hideLoading();
                showError('Failed to load the page. The site might be blocking proxies.');
            };
        }
        
        goBtn.addEventListener('click', () => {
            const url = urlInput.value.trim();
            if (url) {
                navigateTo(url);
            }
        });
        
        urlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const url = urlInput.value.trim();
                if (url) {
                    navigateTo(url);
                }
            }
        });
        
        refreshBtn.addEventListener('click', () => {
            if (currentUrl) {
                navigateTo(currentUrl);
            }
        });
        
        homeBtn.addEventListener('click', () => {
            proxyFrame.style.display = 'none';
            homeScreen.style.display = 'flex';
            currentUrl = '';
            urlInput.value = '';
            proxyFrame.src = 'about:blank';
        });
        
        document.querySelectorAll('.quick-link').forEach(link => {
            link.addEventListener('click', () => {
                const url = link.dataset.url;
                navigateTo(url);
            });
        });
        
        // Listen for messages from iframe (for URL updates)
        window.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'urlChange' && event.data.url) {
                currentUrl = event.data.url;
                urlInput.value = event.data.url;
            }
        });
        
        // Focus input on load
        urlInput.focus();
    </script>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
}

server.listen(PORT, () => {
    console.log(`Proxy server running on http://localhost:${PORT}`);
    console.log('Ready to handle requests!');
});
