/**
 * q-options.js — Q's tap-to-answer buttons, in ONE place.
 *
 * Q ends a reply with a block like:
 *
 *     [OPTIONS]
 *     - Yes, book it
 *     - Tell me the price first
 *     [/OPTIONS]
 *
 * Those are meant to become buttons you tap. When the page doesn't know how to
 * read them, the raw square brackets land on screen as words — which is what
 * Sarah saw (20 Aug 2026: "there shouldnt be square brackets it should be
 * colours or something that looks good").
 *
 * Only chat.html, thread.html and email-writer.html could read them. life.html,
 * writer.html and doc-editor.html all show Q's replies too, and all showed the
 * tags raw. Copying the parser into each was the wrong fix — this is the one
 * implementation, and every page includes it.
 *
 * WHY THE PARSER IS DELIBERATELY FORGIVING
 * The models are not consistent. GLM and V4 variously put the tag inline, drop
 * the closing tag, add a sign-off after it, or emit two blocks. The old parser
 * failed CLOSED on each of those — it gave up and left the brackets on screen.
 * Failing closed is the one outcome that must never happen here: a missed
 * button is a small loss, a page full of [OPTIONS] is broken-looking software.
 * So this strips the tags in every case, and only argues about which lines
 * become buttons.
 *
 *   window.QOptions.parse(text)      → { stripped, options[] }
 *   window.QOptions.render(el, opts, onPick)  → appends the buttons
 *   window.QOptions.styles()         → the CSS, if the page hasn't got it
 */
(function () {
    'use strict';

    var OPEN = '[OPTIONS]';
    var CLOSE = '[/OPTIONS]';

    /**
     * Pull every [OPTIONS] block out of a reply.
     * @param {string} content
     * @returns {{stripped: string, options: string[]}}
     */
    function parse(content) {
        if (!content || typeof content !== 'string') return { stripped: content || '', options: [] };
        if (content.toUpperCase().indexOf(OPEN) === -1) return { stripped: content, options: [] };

        var options = [];
        var out = content;

        // Walk every block, not just the last one. Two blocks used to mean the
        // first one's tags rendered as text.
        for (var guard = 0; guard < 10; guard++) {
            var upper = out.toUpperCase();
            var open = upper.indexOf(OPEN);
            if (open === -1) break;

            var after = out.slice(open + OPEN.length);
            var closeRel = after.toUpperCase().indexOf(CLOSE);

            // No closing tag: everything that still looks like a list item
            // belongs to the block, and prose after it does not.
            var body = closeRel === -1 ? after : after.slice(0, closeRel);
            var rest = closeRel === -1 ? '' : after.slice(closeRel + CLOSE.length);

            if (closeRel === -1) {
                var lines = after.split('\n');
                var taken = [];
                var i = 0;
                for (; i < lines.length; i++) {
                    var ln = lines[i].trim();
                    if (!ln) { if (taken.length) break; else continue; }
                    if (!/^[-*•]\s+/.test(ln)) break;      // prose — the block has ended
                    taken.push(ln);
                }
                body = taken.join('\n');
                rest = lines.slice(i).join('\n');
            }

            body.split('\n').forEach(function (l) {
                var t = l.replace(/^\s*[-*•]\s*/, '').trim();
                // Drop a stray bullet that is only punctuation or an emoji.
                if (t && t.replace(/[\s\p{P}]/gu, '').length > 0) options.push(t);
            });

            out = (out.slice(0, open) + '\n' + rest);
        }

        // Belt and braces: if any tag survived the walk, take it out anyway.
        // A button we failed to build is a small loss. A screen full of square
        // brackets is the thing she actually complained about.
        out = out.replace(/\[\/?OPTIONS\]/gi, '');

        return { stripped: out.replace(/\n{3,}/g, '\n\n').trim(), options: dedupe(options) };
    }

    function dedupe(list) {
        var seen = {}, out = [];
        list.forEach(function (o) {
            var k = o.toLowerCase();
            if (!seen[k]) { seen[k] = 1; out.push(o); }
        });
        return out.slice(0, 8);
    }

    /**
     * Build the buttons. Neumorphic raised pills — the accent shows on hover and
     * press only, never as a solid fill.
     * @param {HTMLElement} container - appended to
     * @param {string[]} options
     * @param {function(string, HTMLElement)} onPick
     */
    function render(container, options, onPick) {
        if (!container || !options || !options.length) return null;
        var wrap = document.createElement('div');
        wrap.className = 'chat-options';
        options.forEach(function (text) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'chat-option';
            b.textContent = text;
            b.addEventListener('click', function () {
                Array.prototype.forEach.call(wrap.querySelectorAll('.chat-option'), function (o) { o.disabled = true; });
                b.classList.add('on');
                if (typeof onPick === 'function') onPick(text, b);
            });
            wrap.appendChild(b);
        });
        container.appendChild(wrap);
        return wrap;
    }

    /** The CSS, for pages that don't already carry it. Injected once. */
    function styles() {
        if (document.getElementById('q-options-styles')) return;
        var css = document.createElement('style');
        css.id = 'q-options-styles';
        css.textContent = [
            '.chat-options{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}',
            '.chat-option{font-family:inherit;font-size:13.5px;font-weight:600;color:var(--text,#1a1a1a);',
            'background:var(--bg,#f3f3f3);border:none;cursor:pointer;padding:10px 16px;border-radius:12px;',
            'box-shadow:var(--neu-raised-sm,6px 6px 16px #ababab,-5px -5px 12px #fff);',
            'transition:all .15s ease;text-align:left;max-width:100%}',
            '.chat-option:hover{color:var(--accent,#e91e63)}',
            '.chat-option:active,.chat-option.on{box-shadow:var(--neu-inset-xs,inset 3px 3px 8px #ababab,inset -2px -2px 6px #fff);color:var(--accent,#e91e63)}',
            '.chat-option:disabled{cursor:default;opacity:.55}',
        ].join('');
        document.head.appendChild(css);
    }

    window.QOptions = { parse: parse, render: render, styles: styles };
})();
