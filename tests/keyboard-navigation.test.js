'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimePath = path.join(__dirname, '../assets/prefab-live.js');

function setup() {
    const listeners = new Map();
    const root = {contains: form => form.root === root};

    class TestElement {
        constructor({tag = 'input', tagged = true, type = 'text', order = '', visible = true} = {}) {
            this.tag = tag;
            this.type = type;
            this.tagged = tagged;
            this.order = order;
            this.visible = visible;
            this.disabled = false;
            this.readOnly = false;
            this.focused = false;
            this.form = null;
            this.nextElementSibling = null;
            this.classList = {contains: name => (this.classes || []).includes(name)};
        }
        hasAttribute(name) { return name === 'pf:enter' && this.tagged; }
        getAttribute(name) { return name === 'pf:enter' && this.tagged ? this.order : null; }
        matches(selector) { return selector === ':disabled' ? this.disabled : false; }
        closest(selector) {
            if (selector === '[hidden], [inert]') return this.inert ? {} : null;
            return selector === '[pf\\:component]' ? this.form?.root : null;
        }
        getClientRects() { return this.visible ? [{}] : []; }
        focus() { this.focused = true; }
    }
    class HTMLInputElement extends TestElement {}
    class HTMLSelectElement extends TestElement {}
    class HTMLTextAreaElement extends TestElement {}
    class HTMLFormElement extends TestElement {
        constructor() { super({tag: 'form'}); this.controls = []; this.root = root; this.submits = 0; }
        append(control) { control.form = this; this.controls.push(control); return control; }
        querySelectorAll() { return this.controls.filter(control => control.tagged); }
        requestSubmit() { this.submits++; }
    }
    const document = {
        documentElement: {},
        querySelectorAll: () => [],
        addEventListener: (name, handler) => listeners.set(name, handler),
    };
    const context = {
        document, window: {}, Element: TestElement, HTMLElement: TestElement,
        HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLFormElement,
        MutationObserver: class {observe() {}}, WeakMap, Set, Array, Object,
    };
    vm.runInNewContext(fs.readFileSync(runtimePath, 'utf8'), context, {filename: runtimePath});
    function press(target, overrides = {}) {
        const event = {
            target, key: 'Enter', ctrlKey: false, shiftKey: false, altKey: false,
            metaKey: false, defaultPrevented: false, repeat: false, isComposing: false,
            keyCode: 13, preventDefault() { this.defaultPrevented = true; },
            ...overrides,
        };
        listeners.get('keydown')(event);
        return event;
    }
    return {HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLFormElement, press, context};
}

test('Enter skips untagged controls and submits from the last tagged control', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    const first = form.append(new HTMLInputElement());
    const skipped = form.append(new HTMLInputElement({tagged: false}));
    const last = form.append(new HTMLInputElement());
    assert.equal(press(first).defaultPrevented, true);
    assert.equal(last.focused, true);
    assert.equal(skipped.focused, false);
    assert.equal(form.submits, 0);
    assert.equal(press(last).defaultPrevented, true);
    assert.equal(form.submits, 1);
    assert.equal(press(skipped).defaultPrevented, false);
});

test('Ctrl+Enter submits from any tagged field without moving focus', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    const first = form.append(new HTMLInputElement());
    const next = form.append(new HTMLInputElement());
    assert.equal(press(first, {ctrlKey: true}).defaultPrevented, true);
    assert.equal(form.submits, 1);
    assert.equal(next.focused, false);
});

test('available controls are recomputed, skipping disabled, readonly and hidden fields', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    const a = form.append(new HTMLInputElement());
    const b = form.append(new HTMLInputElement()); b.disabled = true;
    const c = form.append(new HTMLInputElement()); c.readOnly = true;
    form.append(new HTMLInputElement({visible: false}));
    form.append(new HTMLInputElement({type: 'hidden'}));
    const f = form.append(new HTMLInputElement());
    press(a);
    assert.equal(f.focused, true);
    f.disabled = true;
    press(a);
    assert.equal(form.submits, 1);
});

test('optional numeric order overrides DOM order', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    const third = form.append(new HTMLInputElement({order: '3'}));
    const first = form.append(new HTMLInputElement({order: '1'}));
    const second = form.append(new HTMLInputElement({order: '2'}));
    press(first);
    assert.equal(second.focused, true);
    press(second);
    assert.equal(third.focused, true);
    press(third);
    assert.equal(form.submits, 1);
});

test('navigation stays inside its own form and honors newly added controls', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const firstForm = new HTMLFormElement();
    const otherForm = new HTMLFormElement();
    const start = firstForm.append(new HTMLInputElement());
    const unrelated = otherForm.append(new HTMLInputElement());
    press(start);
    assert.equal(firstForm.submits, 1);
    assert.equal(unrelated.focused, false);
    const added = firstForm.append(new HTMLInputElement());
    press(start);
    assert.equal(added.focused, true);
});

test('normal modified, composing and already-handled keyboard events remain untouched', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    const first = form.append(new HTMLInputElement());
    const next = form.append(new HTMLInputElement());
    for (const event of [
        {shiftKey: true}, {altKey: true}, {metaKey: true},
        {isComposing: true}, {keyCode: 229}, {repeat: true},
        {defaultPrevented: true}, {key: 'Escape'},
    ]) press(first, event);
    assert.equal(next.focused, false);
    assert.equal(form.submits, 0);
});

test('textarea only participates when explicitly tagged', () => {
    const {HTMLInputElement, HTMLTextAreaElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    const first = form.append(new HTMLInputElement());
    form.append(new HTMLTextAreaElement({tagged: false}));
    const next = form.append(new HTMLTextAreaElement());
    press(first);
    assert.equal(next.focused, true);
    press(next);
    assert.equal(form.submits, 1);
});

test('initialized Select2 controls are available focus targets', () => {
    const {HTMLInputElement, HTMLSelectElement, HTMLFormElement, press, context} = setup();
    const form = new HTMLFormElement();
    const first = form.append(new HTMLInputElement());
    const select = form.append(new HTMLSelectElement({tag: 'select', visible: false}));
    select.classes = ['select2-hidden-accessible'];
    select.nextElementSibling = {classList: {contains: name => name === 'select2'}, getClientRects: () => [{}]};
    let opened = false;
    function jq(element) { assert.equal(element, select); return {select2: action => {opened = action === 'open';}}; }
    jq.fn = {select2() {}};
    context.window.jQuery = jq;
    press(first);
    assert.equal(opened, true);
});

test('keyboard submission honors available submit buttons and chooses the first enabled action', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    const input = form.append(new HTMLInputElement());
    const queue = {disabled: true};
    const print = {disabled: false};
    const existingQuery = form.querySelectorAll.bind(form);
    form.querySelectorAll = selector => selector.includes('button[type="submit"]')
        ? [queue, print] : existingQuery(selector);
    form.requestSubmit = submitter => { form.submits++; form.selected = submitter; };
    press(input, {ctrlKey: true});
    assert.equal(form.submits, 1);
    assert.equal(form.selected, print);
    print.disabled = true;
    press(input);
    assert.equal(form.submits, 1);
    queue.disabled = false;
    press(input);
    assert.equal(form.submits, 2);
    assert.equal(form.selected, queue);
});
