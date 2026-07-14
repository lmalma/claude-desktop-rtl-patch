;(function() {
    'use strict';
    if (typeof document === 'undefined') return;
    try {
        var WRITING_SEL = '[data-testid="chat-input"]';

        // --- PURE DETECTION CORE (inlined from src/rtl-core.js by build-payload.ps1) ---
        /*__RTL_CORE__*/
        // --- END PURE DETECTION CORE ---

        // Get text from element excluding <code> children (DOM-aware)
        function textWithoutCode(el) {
            var out = '';
            var nodes = el.childNodes;
            for (var i = 0; i < nodes.length; i++) {
                var n = nodes[i];
                if (n.nodeType === 3) { out += n.textContent; }
                else if (n.nodeType === 1 && n.tagName !== 'CODE' && n.tagName !== 'PRE') {
                    out += textWithoutCode(n);
                }
            }
            return out;
        }

        // --- PER-LINE DIRECTIONAL SPLITTING ---
        //
        // A paragraph rendered with <br> separators or whitespace-pre may carry
        // multiple lines, each in a different script. Forcing a single dir on the
        // host element mangles every line that disagrees. We instead defer to
        // unicode-bidi:plaintext and stamp data-rtl-split so later passes skip it.

        var RTL_SPLIT_FLAG = 'data-rtl-split';
        var BR_OR_NL_SPLIT = /(<br\s*\/?>|\n)/i;

        function hasMultiScriptLines(el) {
            var src = el.textContent;
            if (!src) return false;
            if (!/[a-zA-Z]{2,}/.test(src)) return false;
            if (!hasRTL(src)) return false;
            return BR_OR_NL_SPLIT.test(el.innerHTML) || src.indexOf('\n') !== -1;
        }

        function splitToDirectionalSpans(el) {
            if (el.hasAttribute(RTL_SPLIT_FLAG)) return;
            // No DOM rewriting -- assigning el.innerHTML broke React reconciliation
            // ("Failed to execute 'removeChild' on 'Node'"). Defer to
            // unicode-bidi:plaintext: <br> is a paragraph separator in the Unicode
            // BiDi algorithm, so each line auto-picks its direction from first-strong.
            el.setAttribute(RTL_SPLIT_FLAG, '1');
            if (el.hasAttribute('dir')) el.removeAttribute('dir');
            el.style.direction = '';
            el.style.textAlign = 'start';
            el.style.unicodeBidi = 'plaintext';
        }

        // If the element inherits RTL via a parent CSS class (not an explicit dir
        // attribute on itself), removing dir alone won't free it -- pin direction=ltr.
        function resetDirOrPinLTR(el) {
            if (window.getComputedStyle(el).direction === 'rtl') {
                el.dir = 'ltr';
                el.style.direction = 'ltr';
                return;
            }
            if (el.hasAttribute('dir')) el.removeAttribute('dir');
            el.style.direction = '';
        }

        // --- HYBRID DIRECTION DETECTION ---

        // For DOM elements (output): 3-layer detection
        function detectElDir(el) {
            var full = el.textContent || '';
            if (!hasRTL(full)) return null;

            // Layer 1: first-strong on text excluding <code> children
            var noCode = textWithoutCode(el);
            var d = firstStrong(noCode);
            if (d === 'rtl') return 'rtl';

            // Layer 2: strip leading filenames/URLs, then first-strong
            var stripped = stripLeadingLTR(noCode);
            d = firstStrong(stripped);
            if (d === 'rtl') return 'rtl';

            // Layer 3: RTL chars exist but hide behind code/filenames -> treat as RTL.
            return 'rtl';
        }

        // For plain text (input box, dialogs without DOM structure)
        function detectTextDir(text) {
            if (!text || !text.trim()) return null;
            var d = firstStrong(text);
            if (d === 'rtl') return 'rtl';
            if (!hasRTL(text)) return 'ltr';

            var stripped = stripLeadingLTR(text);
            d = firstStrong(stripped);
            if (d === 'rtl') return 'rtl';

            return 'rtl';
        }

        // --- ELEMENT PROCESSING ---

        // querySelectorAll that INCLUDES root itself if it matches
        function qsa(root, sel) {
            var base = root.querySelectorAll ? root : document;
            var els = Array.from(base.querySelectorAll(sel));
            if (root.matches && root.matches(sel)) els.unshift(root);
            return els;
        }

        function forceCodeLTR(root) {
            qsa(root, 'pre, .code-block__code, .relative.group\\/copy').forEach(function(b) {
                b.dir = 'ltr'; b.style.textAlign = 'left'; b.style.unicodeBidi = 'embed';
            });
            qsa(root, 'code').forEach(function(c) {
                if (!c.closest('pre') && !c.closest('.code-block__code')) c.dir = 'ltr';
            });
            // Rendered math (KaTeX/MathJax), if present, is an LTR island too.
            qsa(root, '.katex, .katex-display, mjx-container').forEach(function(m) {
                m.style.unicodeBidi = 'isolate'; m.style.direction = 'ltr';
            });
        }

        // --- RAW LaTeX + BARE-ARITHMETIC ISOLATION ---
        //
        // Claude Desktop (Windows) does not render LaTeX -- it shows raw "$...$" text.
        // Inside an RTL paragraph the neutral $ \ { } chars scramble the formula, and
        // bare arithmetic ("2 + 3 = 5", "5-3", "x = 10") gets mirrored to "5 = 3 + 2"
        // by the bidi algorithm. We isolate each math segment (LaTeX or bare numeric,
        // per segmentText) in its own ltr/unicode-bidi:isolate span. We replace a
        // single TEXT node with a fragment (replaceChild) -- never innerHTML -- to stay
        // gentle on React reconciliation, and flag islands so we never re-wrap during
        // streaming.
        var ISLAND_FLAG = 'data-rtl-island';

        function isolateMath(root) {
            if (typeof document.createTreeWalker !== 'function') return;
            var host = (root && root.nodeType === 1) ? root : document.body;
            if (!host) return;
            var walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
                acceptNode: function(node) {
                    var v = node.nodeValue;
                    if (!v) return NodeFilter.FILTER_REJECT;
                    // Cheap pre-filter: a LaTeX hint ($ or \), OR a numeric hint
                    // (a digit AND an operator). MATH_DIGIT_RE / MATH_OP_RE come from
                    // the inlined core above and are stateless (no /g flag).
                    var hasTex = v.indexOf('$') !== -1 || v.indexOf('\\') !== -1;
                    var hasNum = MATH_DIGIT_RE.test(v) && MATH_OP_RE.test(v);
                    if (!hasTex && !hasNum) return NodeFilter.FILTER_REJECT;
                    var p = node.parentElement;
                    if (!p) return NodeFilter.FILTER_REJECT;
                    if (p.tagName === 'SCRIPT' || p.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
                    if (p.closest('pre, code, .code-block__code, [' + ISLAND_FLAG + '], ' + WRITING_SEL)) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
            // Collect first -- mutating during the walk invalidates the walker.
            var targets = [];
            var n;
            while ((n = walker.nextNode())) targets.push(n);
            targets.forEach(function(textNode) {
                var segs = segmentText(textNode.nodeValue);
                var hasMath = segs.some(function(s) { return s.type === 'math'; });
                if (!hasMath) return;
                var frag = document.createDocumentFragment();
                segs.forEach(function(s) {
                    if (s.type === 'math') {
                        var span = document.createElement('span');
                        span.setAttribute(ISLAND_FLAG, '1');
                        span.style.unicodeBidi = 'isolate';
                        span.style.direction = 'ltr';
                        span.textContent = s.value;
                        frag.appendChild(span);
                    } else {
                        frag.appendChild(document.createTextNode(s.value));
                    }
                });
                if (textNode.parentNode) textNode.parentNode.replaceChild(frag, textNode);
            });
        }

        // --- TABLE COLUMN ORDERING ---
        //
        // A Hebrew table should read right-to-left: the first column on the right.
        // Per-cell direction is handled by processText; here we only flip the whole
        // table's column order via dir="rtl" on a stable <table> element (no text
        // surgery, low risk). Only flip once we are confident it is a Hebrew table;
        // leave the flag off otherwise so a table still streaming can re-evaluate.
        var TABLE_FLAG = 'data-rtl-table';

        function processTables(root) {
            qsa(root, 'table').forEach(function(t) {
                if (t.getAttribute(TABLE_FLAG) === 'rtl') return;
                if (t.closest(WRITING_SEL)) return;
                var headerCells = Array.from(t.querySelectorAll('thead th'));
                if (!headerCells.length) {
                    var firstRow = t.querySelector('tr');
                    if (firstRow) headerCells = Array.from(firstRow.querySelectorAll('th, td'));
                }
                var headerDirs = headerCells.map(function(c) { return cellDir(c.textContent || ''); });
                var rows = Array.from(t.querySelectorAll('tbody tr'));
                if (!rows.length) rows = Array.from(t.querySelectorAll('tr')).slice(1);
                var firstColDirs = rows.map(function(r) {
                    var cell = r.querySelector('th, td');
                    return cell ? cellDir(cell.textContent || '') : null;
                });
                if (tableDirFromCells(headerDirs, firstColDirs) === 'rtl') {
                    t.setAttribute(TABLE_FLAG, 'rtl');
                    t.dir = 'rtl';
                    t.style.direction = 'rtl';
                }
            });
        }

        function processText(root) {
            // Standard text elements
            qsa(root, 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, summary, label, dt, dd').forEach(function(el) {
                if (el.closest(WRITING_SEL) || el.closest('pre') || el.closest('.code-block__code')) return;
                if (el.hasAttribute(RTL_SPLIT_FLAG)) return;
                var dir = detectElDir(el);
                if (dir) {
                    if (dir === 'rtl' && hasMultiScriptLines(el)) {
                        splitToDirectionalSpans(el);
                        return;
                    }
                    el.dir = dir;
                    el.style.direction = dir;
                    if (el.tagName === 'LI') {
                        el.style.listStylePosition = (dir === 'rtl') ? 'inside' : '';
                        var parentList = el.closest('ul, ol');
                        if (parentList && dir === 'rtl' && !parentList.hasAttribute('dir')) {
                            parentList.dir = 'rtl';
                            parentList.style.direction = 'rtl';
                            var pl = getComputedStyle(parentList).paddingLeft;
                            if (parseFloat(pl) > 0) { parentList.style.paddingRight = pl; parentList.style.paddingLeft = '0'; }
                        }
                    }
                } else {
                    resetDirOrPinLTR(el);
                    if (el.tagName === 'LI') el.style.listStylePosition = '';
                }
            });

            // Lists
            qsa(root, 'ul, ol').forEach(function(el) {
                if (el.closest(WRITING_SEL) || el.closest('pre')) return;
                var dir = detectElDir(el);
                if (dir === 'rtl') {
                    el.dir = 'rtl';
                    el.style.direction = 'rtl';
                    var pl = getComputedStyle(el).paddingLeft;
                    if (parseFloat(pl) > 0) { el.style.paddingRight = pl; el.style.paddingLeft = '0'; }
                } else {
                    resetDirOrPinLTR(el);
                    el.style.paddingRight = ''; el.style.paddingLeft = '';
                }
            });
        }

        // Universal: process ANY leaf text container (catches dialogs, tooltips, etc.)
        function processContainers(root) {
            qsa(root, 'div, span, button, a, label').forEach(function(el) {
                if (el.closest('pre') || el.closest('code') || el.closest(WRITING_SEL)) return;
                if (el.hasAttribute(RTL_SPLIT_FLAG)) return;
                if (el.hasAttribute(ISLAND_FLAG)) return;
                var parent = el.parentElement;
                if (parent && parent.hasAttribute(RTL_SPLIT_FLAG)) return;
                if (el.querySelector('p, div, ul, ol, h1, h2, h3, h4, h5, h6, pre, table')) return;
                if (/^(P|LI|H[1-6]|BLOCKQUOTE|TD|TH|UL|OL)$/.test(el.tagName)) return;
                var text = (el.textContent || '').trim();
                if (text.length < 2) return;
                if (hasRTL(text)) {
                    if (hasMultiScriptLines(el)) {
                        splitToDirectionalSpans(el);
                    } else {
                        el.dir = detectTextDir(text) || 'rtl';
                        el.style.textAlign = 'start';
                    }
                } else if (el.hasAttribute('dir')) {
                    el.removeAttribute('dir');
                    el.style.textAlign = '';
                }
            });
        }

        function processInput() {
            document.querySelectorAll(WRITING_SEL).forEach(function(input) {
                var text = input.textContent || input.innerText || '';
                var dir = detectTextDir(text);
                if (dir === 'rtl') {
                    input.style.direction = 'rtl'; input.style.textAlign = 'right'; input.style.paddingRight = '25px';
                } else {
                    input.style.direction = 'ltr'; input.style.textAlign = 'left'; input.style.paddingRight = '';
                }
            });
        }

        function processAll() {
            isolateMath(document.body);
            processText(document);
            processContainers(document.body);
            processTables(document.body);
            processInput();
            forceCodeLTR(document.body);
        }

        function injectStyles() {
            if (document.getElementById('claude-rtl-styles')) return;
            var s = document.createElement('style');
            s.id = 'claude-rtl-styles';
            s.textContent = [
                'p:not([dir]),li:not([dir]),h1:not([dir]),h2:not([dir]),h3:not([dir]),h4:not([dir]),h5:not([dir]),h6:not([dir]),blockquote:not([dir]),td:not([dir]),th:not([dir]),summary:not([dir]),label:not([dir]),legend:not([dir]),dt:not([dir]),dd:not([dir]),figcaption:not([dir]),caption:not([dir]){unicode-bidi:plaintext!important;text-align:start!important}',
                'pre,.code-block__code,.relative.group\\/copy{unicode-bidi:embed!important;direction:ltr!important;text-align:left!important}',
                'code{unicode-bidi:isolate!important;direction:ltr!important}',
                // Raw LaTeX islands and rendered math are isolated LTR units.
                '[data-rtl-island]{unicode-bidi:isolate!important;direction:ltr!important}',
                '.katex,.katex-display,mjx-container{unicode-bidi:isolate!important;direction:ltr!important}',
                // Hebrew tables: flip column order; cells keep their own direction.
                'table[dir="rtl"]{direction:rtl!important}',
                '[dir]{text-align:start!important}[dir="rtl"]{direction:rtl!important}[dir="ltr"]{direction:ltr!important}',
                '[dir]>*:not([dir]):not(pre):not(code):not(.code-block__code){unicode-bidi:plaintext;text-align:start}',
                // RTL: flip sidebar truncation gradient to fade the LEFT edge (issue #7).
                '[dir="rtl"][class*="mask-image:linear-gradient(to_right"]{-webkit-mask-image:linear-gradient(to left,hsl(var(--always-black)) 85%,transparent 99%)!important;mask-image:linear-gradient(to left,hsl(var(--always-black)) 85%,transparent 99%)!important}',
                '.group:hover [dir="rtl"][class*="mask-image:linear-gradient(to_right"],.group:focus-within [dir="rtl"][class*="mask-image:linear-gradient(to_right"],[data-menu-open="true"] [dir="rtl"][class*="mask-image:linear-gradient(to_right"]{-webkit-mask-image:linear-gradient(to left,hsl(var(--always-black)) 60%,transparent 78%)!important;mask-image:linear-gradient(to left,hsl(var(--always-black)) 60%,transparent 78%)!important}'
            ].join('');
            document.head.appendChild(s);
        }

        // --- USER CONTROL PANEL (chat font family/size + DevTools) ------------
        // A small gear button (top-right, below the window controls). Hover or
        // click it to set the chat font family/size or open DevTools. Settings
        // persist in localStorage and re-apply on every launch. The panel lives
        // in a Shadow DOM so its markup/styles are isolated from the page AND
        // from the RTL processors above (which walk the light DOM only).
        var RTL_SETTINGS_KEY = 'claudeRtlUiSettings';
        // Chat message text we restyle. If a future Claude build renames these,
        // open DevTools from the panel to find the new class and tell the patch.
        var RTL_MSG_SEL = '.font-claude-message, .font-user-message, [data-testid="user-message"], [data-testid="chat-input"], .prose';
        var RTL_FONTS = [
            ['Default', ''],
            ['System UI', 'system-ui, "Segoe UI", sans-serif'],
            ['Arial', 'Arial, sans-serif'],
            ['Calibri', 'Calibri, sans-serif'],
            ['Georgia', 'Georgia, serif'],
            ['Times New Roman', '"Times New Roman", serif'],
            ['David (Hebrew)', '"David", "David CLM", serif'],
            ['Frank Ruehl (Hebrew)', '"FrankRuehl", "Frank Ruehl CLM", serif'],
            ['Courier New', '"Courier New", monospace']
        ];

        function rtlLoadSettings() {
            try { var raw = localStorage.getItem(RTL_SETTINGS_KEY); if (raw) return JSON.parse(raw); } catch (e) {}
            return { fontFamily: '', fontScale: 1 };
        }
        function rtlSaveSettings(s) {
            try { localStorage.setItem(RTL_SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
        }
        function rtlApplySettings(s) {
            var st = document.getElementById('claude-rtl-user-style');
            if (!st) {
                st = document.createElement('style');
                st.id = 'claude-rtl-user-style';
                (document.head || document.documentElement).appendChild(st);
            }
            var scale = (s && s.fontScale) ? s.fontScale : 1;
            var fam = (s && s.fontFamily) ? s.fontFamily : '';
            var css = RTL_MSG_SEL + '{font-size:calc(' + scale + ' * 1em)!important;}';
            if (fam) {
                css += RTL_MSG_SEL + '{font-family:' + fam + '!important;}';
                // keep code/pre monospaced regardless of the chosen prose font
                css += '.prose code,.prose pre,code,pre,pre *,code *{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace!important;}';
            }
            st.textContent = css;
        }

        function initControlPanel() {
            if (!document.body || document.getElementById('claude-rtl-panel')) return;

            var settings = rtlLoadSettings();
            rtlApplySettings(settings);

            var host = document.createElement('div');
            host.id = 'claude-rtl-panel';
            host.setAttribute('dir', 'ltr');
            host.style.cssText = 'position:fixed;top:40px;right:10px;z-index:2147483647;';
            // Electron custom title bars are drag regions; keep our widget clickable.
            host.style.webkitAppRegion = 'no-drag';
            var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

            var fontOptions = RTL_FONTS.map(function(f) {
                var sel = (f[1] === settings.fontFamily) ? ' selected' : '';
                return '<option value="' + f[1].replace(/"/g, '&quot;') + '"' + sel + '>' + f[0] + '</option>';
            }).join('');

            root.innerHTML =
                '<style>' +
                ':host,*{box-sizing:border-box;font-family:system-ui,"Segoe UI",sans-serif}' +
                '.gear{width:32px;height:32px;border-radius:8px;background:rgba(30,30,30,.82);color:#eee;border:1px solid rgba(255,255,255,.15);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:17px;box-shadow:0 2px 8px rgba(0,0,0,.35);user-select:none}' +
                '.gear:hover{background:rgba(50,50,50,.95)}' +
                '.menu{position:absolute;top:38px;right:0;width:232px;background:rgba(28,28,30,.98);color:#eee;border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:12px;box-shadow:0 8px 28px rgba(0,0,0,.5);display:none;font-size:13px}' +
                '.wrap:hover .menu,.menu.pin{display:block}' +
                '.row{margin:8px 0}' +
                '.row label{display:block;margin-bottom:4px;opacity:.8;font-size:12px}' +
                'select{width:100%;padding:5px;border-radius:6px;background:#111;color:#eee;border:1px solid rgba(255,255,255,.2);font:inherit}' +
                '.sz{display:flex;align-items:center;gap:8px}' +
                '.sz button{width:30px;height:30px;border-radius:6px;background:#111;color:#eee;border:1px solid rgba(255,255,255,.2);cursor:pointer;font-size:16px;font:inherit}' +
                '.sz span{flex:1;text-align:center}' +
                '.act{width:100%;padding:7px;border-radius:6px;background:#2b6cb0;color:#fff;border:0;cursor:pointer;margin-top:4px;font:inherit}' +
                '.act.sec{background:#333}' +
                '</style>' +
                '<div class="wrap">' +
                '<div class="gear" title="Claude RTL settings">&#9881;</div>' +
                '<div class="menu">' +
                '<div class="row"><label>Chat font</label><select class="ff">' + fontOptions + '</select></div>' +
                '<div class="row"><label>Font size</label><div class="sz"><button class="dec">&#8722;</button><span class="val"></span><button class="inc">+</button></div></div>' +
                '<div class="row"><button class="act dev">Open DevTools</button></div>' +
                '<div class="row"><button class="act sec reset">Reset</button></div>' +
                '</div></div>';

            (document.body || document.documentElement).appendChild(host);

            var menu = root.querySelector('.menu');
            var val = root.querySelector('.val');
            var ff = root.querySelector('.ff');
            function renderVal() { val.textContent = Math.round((settings.fontScale || 1) * 100) + '%'; }
            renderVal();

            root.querySelector('.gear').addEventListener('click', function() { menu.classList.toggle('pin'); });
            ff.addEventListener('change', function() {
                settings.fontFamily = ff.value; rtlSaveSettings(settings); rtlApplySettings(settings);
            });
            function bump(delta) {
                var s = (settings.fontScale || 1) + delta;
                s = Math.max(0.7, Math.min(2, Math.round(s * 100) / 100));
                settings.fontScale = s; renderVal(); rtlSaveSettings(settings); rtlApplySettings(settings);
            }
            root.querySelector('.dec').addEventListener('click', function() { bump(-0.1); });
            root.querySelector('.inc').addEventListener('click', function() { bump(0.1); });
            root.querySelector('.dev').addEventListener('click', function() {
                // No preload/IPC bridge exists; signal the main process with a magic
                // console message (the main-process patch listens and opens DevTools).
                try { console.log('__CLAUDE_RTL_OPEN_DEVTOOLS__'); } catch (e) {}
            });
            root.querySelector('.reset').addEventListener('click', function() {
                settings = { fontFamily: '', fontScale: 1 };
                ff.value = ''; renderVal(); rtlSaveSettings(settings); rtlApplySettings(settings);
            });
        }

        function init() {
            injectStyles();
            initControlPanel();
            processAll();

            // Input box live direction switching
            document.addEventListener('input', function(e) {
                var t = e.target;
                if (!t || !(t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
                var text = t.textContent || t.innerText || t.value || '';
                var dir = detectTextDir(text);
                if (dir === 'rtl') {
                    t.style.direction = 'rtl'; t.style.textAlign = 'right'; t.style.paddingRight = '25px';
                } else {
                    t.style.direction = 'ltr'; t.style.textAlign = 'left'; t.style.paddingRight = '';
                }
            }, true);

            // Watch DOM changes (throttle, not debounce -- process DURING streaming)
            var pendingMuts = [];
            var obs = new MutationObserver(function(muts) {
                var dominated = false;
                for (var i = 0; i < muts.length; i++) {
                    if (muts[i].addedNodes.length > 0 || muts[i].type === 'characterData') { dominated = true; break; }
                }
                if (!dominated) return;
                for (var j = 0; j < muts.length; j++) pendingMuts.push(muts[j]);
                if (window._rtlT) return; // throttle: already scheduled
                window._rtlT = setTimeout(function() {
                    window._rtlT = null;
                    var toProcess = pendingMuts;
                    pendingMuts = [];
                    var roots = new Set();
                    toProcess.forEach(function(m) {
                        m.addedNodes.forEach(function(n) { if (n.nodeType === 1) roots.add(n); });
                        if (m.type === 'characterData' && m.target.parentElement) roots.add(m.target.parentElement);
                    });
                    var expanded = new Set(roots);
                    roots.forEach(function(r) {
                        if (!r.closest) return;
                        var txt = r.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, summary, label, dt, dd');
                        if (txt) expanded.add(txt);
                        var list = r.closest('ul, ol');
                        if (list) expanded.add(list);
                        var tbl = r.closest('table');
                        if (tbl) expanded.add(tbl);
                    });
                    roots = expanded;
                    if (roots.size > 0 && roots.size <= 30) {
                        roots.forEach(function(r) {
                            isolateMath(r);
                            processText(r);
                            processContainers(r);
                            processTables(r);
                            forceCodeLTR(r);
                        });
                        processInput();
                    } else {
                        processAll();
                    }
                    initControlPanel();   // re-add the panel if a re-render removed it
                }, 50);
            });
            obs.observe(document.body, { childList: true, subtree: true, characterData: true });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else { init(); }
    } catch(e) { console.error('[Claude RTL]', e); }
})();
