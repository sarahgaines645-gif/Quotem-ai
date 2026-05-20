/**
 * CustomSelect — drop-in replacement for native <select> with full CSS
 * control over the open options list. The native select on Chrome/Edge/
 * Windows renders an OS-styled option list that can't be styled, so the
 * neumorphic floating card / life modal looked broken when opened.
 *
 * Markup (drop one of these wherever you'd use a <select id="…">):
 *
 *   <div class="custom-select" id="at-category" data-placeholder="No sub-header"></div>
 *
 * JS:
 *   const cs = CustomSelect.attach('at-category', [
 *     { value: '', label: 'No sub-header' },
 *     { value: 'work', label: 'Work' },
 *   ]);
 *   cs.setValue('work');
 *   cs.onChange = (value, label) => { … };
 *
 * Accessors anywhere in the page:
 *   csGet('at-category')         // current value
 *   csSet('at-category', 'work') // set value
 *   csSetOptions('at-category', […]) // re-populate
 *
 * Behaviour: click trigger to open; click an option to select + close;
 * click outside or Escape to close; only one open at a time.
 */
(function () {
  'use strict';

  const REGISTRY = {};

  function CustomSelect(el, options) {
    this.el = el;
    this.placeholder = el.dataset.placeholder || 'Select…';
    this.options = [];
    this.value = '';
    this.onChange = null;
    el.innerHTML = '';
    el.classList.add('custom-select');

    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.trigger.className = 'cs-trigger';
    el.appendChild(this.trigger);

    this.list = document.createElement('div');
    this.list.className = 'cs-list';
    el.appendChild(this.list);

    this.trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.classList.contains('open')) this._close();
      else this._open();
    });

    this.setOptions(options || []);
  }

  CustomSelect.prototype.setOptions = function (options) {
    this.options = Array.isArray(options) ? options.map(o => ({
      value: o.value == null ? '' : String(o.value),
      label: o.label == null ? String(o.value || '') : String(o.label),
    })) : [];
    // Keep current value only if it's still in the options.
    if (!this.options.find(o => o.value === this.value)) this.value = '';
    this._renderTrigger();
    this._renderList();
  };
  CustomSelect.prototype.setValue = function (value) {
    const v = value == null ? '' : String(value);
    if (!this.options.find(o => o.value === v)) {
      this.value = '';
    } else {
      this.value = v;
    }
    this._renderTrigger();
    this._renderList();
  };
  CustomSelect.prototype.getValue = function () { return this.value; };

  CustomSelect.prototype._renderTrigger = function () {
    const opt = this.options.find(o => o.value === this.value);
    this.trigger.innerHTML = '';
    const lbl = document.createElement('span');
    lbl.className = 'cs-label';
    lbl.textContent = opt ? opt.label : this.placeholder;
    if (!opt) lbl.classList.add('cs-placeholder');
    this.trigger.appendChild(lbl);
    const chev = document.createElement('span');
    chev.className = 'cs-chev';
    chev.textContent = '▾';
    this.trigger.appendChild(chev);
  };
  CustomSelect.prototype._renderList = function () {
    this.list.innerHTML = '';
    this.options.forEach(o => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cs-option' + (o.value === this.value ? ' on' : '');
      b.textContent = o.label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const changed = this.value !== o.value;
        this.value = o.value;
        this._renderTrigger();
        this._renderList();
        this._close();
        if (changed && typeof this.onChange === 'function') this.onChange(o.value, o.label);
      });
      this.list.appendChild(b);
    });
  };
  CustomSelect.prototype._open = function () {
    // Close any other open dropdowns first — only one open at a time.
    document.querySelectorAll('.custom-select.open').forEach(n => n.classList.remove('open'));
    this.el.classList.add('open');
  };
  CustomSelect.prototype._close = function () { this.el.classList.remove('open'); };

  // Global click + escape to close any open dropdown.
  document.addEventListener('click', (e) => {
    document.querySelectorAll('.custom-select.open').forEach(n => {
      if (!n.contains(e.target)) n.classList.remove('open');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.custom-select.open').forEach(n => n.classList.remove('open'));
    }
  });

  // ── Public API ──────────────────────────────────────────────────────
  window.CustomSelect = {
    attach: function (idOrEl, options) {
      const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
      if (!el) return null;
      const cs = new CustomSelect(el, options);
      if (el.id) REGISTRY[el.id] = cs;
      return cs;
    },
    get: function (id) { return REGISTRY[id] || null; },
  };
  window.csGet = function (id) { const c = REGISTRY[id]; return c ? c.getValue() : ''; };
  window.csSet = function (id, value) { const c = REGISTRY[id]; if (c) c.setValue(value); };
  window.csSetOptions = function (id, options) { const c = REGISTRY[id]; if (c) c.setOptions(options); };
  window.csOnChange = function (id, fn) { const c = REGISTRY[id]; if (c) c.onChange = fn; };
})();
