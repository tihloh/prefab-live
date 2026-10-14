'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimePath = path.join(__dirname, '../assets/prefab-live.js');

function setup({select2 = false} = {}) {
    const listeners = new Map();
    const timeouts = [];
    const allSelect2 = [];
    const root = {contains: element => element?.root === root || element?.form?.root === root};

    class TestElement {
        constructor({tag = 'input', tagged = true, type = 'text', order = '', visible = true, preferred = false} = {}) {
            this.tag = tag;
            this.type = type;
            this.tagged = tagged;
            this.preferred = preferred;
            this.order = order;
            this.visible = visible;
            this.disabled = false;
            this.readOnly = false;
            this.focused = false;
            this.form = null;
            this.attributes = [];
            this.id = '';
            this.nextElementSibling = null;
            this.search = false;
            this.select2Open = false;
            this.classList = {contains: name => (this.classes || []).includes(name)};
        }
        hasAttribute(name) {
            return (name === 'pf:enter' && this.tagged)
                || (name === 'pf:enter-default' && this.preferred);
        }
        getAttribute(name) { return name === 'pf:enter' && this.tagged ? this.order : null; }
        matches(selector) {
            if (selector === ':disabled') return this.disabled;
            if (selector === 'input.select2-search__field' || selector === '.select2-search__field') {
                return this.search;
            }
            if (selector.includes('button[type="submit"]')) {
                return this.tag === 'button' && (this.type === 'submit' || this.type === '')
                    || this.tag === 'input' && this.type === 'submit';
            }
            return false;
        }
        closest(selector) {
            if (selector === '[hidden], [inert]') return this.inert ? {} : null;
            if (selector === '.select2-container') return this.widgetContainer || null;
            return selector === '[pf\\:component]' ? this.form?.root : null;
        }
        getClientRects() { return this.visible ? [{}] : []; }
        focus() {
            this.focused = true;
            listeners.get('focusin')?.({target: this});
        }
    }
    class HTMLInputElement extends TestElement {}
    class HTMLSelectElement extends TestElement {
        showPicker() {
            if (this.pickerUnsupported) throw new Error('showPicker unavailable');
            this.pickerCalls = (this.pickerCalls || 0) + 1;
        }
    }
    class HTMLTextAreaElement extends TestElement {}
    class HTMLFormElement extends TestElement {
        constructor() {
            super({tag: 'form'});
            this.controls = [];
            this.buttons = [];
            this.root = root;
            this.submits = 0;
            this.endBehavior = null;
        }
        append(control) { control.form = this; this.controls.push(control); return control; }
        addButton(type = 'submit', preferred = false) {
            const button = new TestElement({tag: 'button', tagged: false, type, preferred});
            this.buttons.push(button);
            return button;
        }
        getAttribute(name) {
            return name === 'pf:enter-end' ? this.endBehavior : super.getAttribute(name);
        }
        querySelectorAll(selector) {
            if (selector.startsWith('button')) {
                return selector.includes('button,') ? this.buttons
                    : this.buttons.filter(button => button.type === 'submit' || button.type === '');
            }
            return this.controls.filter(control => control.tagged);
        }
        requestSubmit(submitter) { this.submits++; this.submitter = submitter || null; }
    }
    const document = {
        documentElement: {},
        querySelectorAll: selector => selector.startsWith('select[pf') ? allSelect2 : [],
        addEventListener: (name, handler, capture = false) => listeners.set(capture ? name + ':capture' : name, handler),
    };
    function jquery(target) {
        if (target === document) return {on: (name, handler) => listeners.set(name, handler)};
        return {
            data: name => name === 'select2' ? {isOpen: () => target.select2Open} : null,
            select2: action => { if (action === 'open') target.select2Open = true; },
        };
    }
    jquery.fn = {select2() {}};
    const context = {
        document, window: select2 ? {jQuery: jquery} : {}, Element: TestElement, HTMLElement: TestElement,
        HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLFormElement,
        MutationObserver: class {observe() {}}, WeakMap, Set, Array, Object,
        setTimeout: callback => { timeouts.push(callback); return timeouts.length; },
        Promise,
    };
    vm.runInNewContext(fs.readFileSync(runtimePath, 'utf8'), context, {filename: runtimePath});
    function press(target, overrides = {}) {
        const event = {
            target, key: 'Enter', ctrlKey: false, shiftKey: false, altKey: false,
            metaKey: false, defaultPrevented: false, repeat: false, isComposing: false,
            keyCode: 13, preventDefault() { this.defaultPrevented = true; },
            ...overrides,
        };
        listeners.get('keydown:capture')?.(event);
        listeners.get('keydown')(event);
        return event;
    }
    return {
        HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLFormElement,
        press, context, allSelect2, timeouts,
        focusIn: target => listeners.get('focusin')?.({target}),
        keyUp: target => listeners.get('keyup')?.({key: 'Enter', target}),
        change: target => listeners.get('change')?.({target}),
        select2Closing: target => listeners.get('select2:closing.pfEnter')?.({target}),
        select2Close: target => listeners.get('select2:close.pfEnter')?.({target}),
        select: target => listeners.get('select2:select.pfEnter')?.({target}),
    };
}

test('Enter skips untagged controls and submits from the last tagged control', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    form.endBehavior = 'submit';
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
    form.endBehavior = 'submit';
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
    form.endBehavior = 'submit';
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
    firstForm.endBehavior = 'submit';
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
    form.endBehavior = 'submit';
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
    form.endBehavior = 'submit';
    const input = form.append(new HTMLInputElement());
    const queue = form.addButton();
    const print = form.addButton();
    queue.disabled = true;
    press(input, {ctrlKey: true});
    assert.equal(form.submits, 1);
    assert.equal(form.submitter, print);
    print.disabled = true;
    press(input);
    assert.equal(form.submits, 1);
    queue.disabled = false;
    press(input);
    assert.equal(form.submits, 2);
    assert.equal(form.submitter, queue);
});

test('last field focuses the default submit button without submitting by default', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    const field = form.append(new HTMLInputElement());
    form.addButton('button');
    const save = form.addButton();
    assert.equal(press(field).defaultPrevented, true);
    assert.equal(save.focused, true);
    assert.equal(form.submits, 0);
});

test('pf:enter-default chooses the focus target and keyboard submit action', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    const field = form.append(new HTMLInputElement());
    const queue = form.addButton();
    const print = form.addButton('submit', true);
    press(field);
    assert.equal(print.focused, true);
    assert.equal(queue.focused, false);
    press(field, {ctrlKey: true});
    assert.equal(form.submitter, print);
    assert.equal(form.submits, 1);
});

test('pf:enter-end none prevents browser implicit submission on the last input', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    form.endBehavior = 'none';
    const field = form.append(new HTMLInputElement());
    const save = form.addButton();
    assert.equal(press(field).defaultPrevented, true);
    assert.equal(save.focused, false);
    assert.equal(form.submits, 0);
    press(field, {ctrlKey: true});
    assert.equal(form.submits, 1);
    assert.equal(form.submitter, save);
});

test('invalid end behavior falls back to safe focus mode', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    form.endBehavior = 'unknown';
    const field = form.append(new HTMLInputElement());
    const button = form.addButton();
    press(field);
    assert.equal(button.focused, true);
    assert.equal(form.submits, 0);
});

test('enabled marked non-submit action may be focused but Ctrl+Enter still submits', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    const field = form.append(new HTMLInputElement());
    const review = form.addButton('button', true);
    const save = form.addButton();
    press(field);
    assert.equal(review.focused, true);
    assert.equal(form.submits, 0);
    press(field, {ctrlKey: true});
    assert.equal(form.submits, 1);
    assert.equal(form.submitter, save);
});

test('tagged checkbox and radio controls can participate in navigation', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    const check = form.append(new HTMLInputElement({type: 'checkbox'}));
    const radio = form.append(new HTMLInputElement({type: 'radio'}));
    const next = form.append(new HTMLInputElement());
    press(check);
    assert.equal(radio.focused, true);
    press(radio);
    assert.equal(next.focused, true);
});

test('disabled preferred button falls back to an available submit button', () => {
    const {HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    const field = form.append(new HTMLInputElement());
    const preferred = form.addButton('submit', true);
    preferred.disabled = true;
    const alternate = form.addButton();
    press(field);
    assert.equal(alternate.focused, true);
    press(field, {ctrlKey: true});
    assert.equal(form.submitter, alternate);
});

test('Select2 keyboard selection advances into the next tagged field in numeric order', () => {
    const {HTMLInputElement, HTMLSelectElement, HTMLFormElement, press, allSelect2, timeouts, select} =
        setup({select2: true});
    const form = new HTMLFormElement();
    const before = form.append(new HTMLInputElement({order: '60'}));
    const program = form.append(new HTMLSelectElement({tag: 'select', order: '70', visible: false}));
    program.classes = ['select2-hidden-accessible'];
    program.select2Open = true;
    program.nextElementSibling = {classList: {contains: name => name === 'select2'}, getClientRects: () => [{}]};
    allSelect2.push(program);
    const fund = form.append(new HTMLSelectElement({tag: 'select', order: '80'}));
    const search = new HTMLInputElement({tagged: false});
    search.search = true;
    press(search);
    select(program);
    assert.equal(timeouts.length, 1);
    timeouts.shift()();
    assert.equal(fund.focused, true);
    assert.equal(before.focused, false);
    assert.equal(form.submits, 0);
});

test('Select2 mouse selection does not advance keyboard focus', () => {
    const {HTMLInputElement, HTMLSelectElement, HTMLFormElement, select, timeouts, allSelect2} =
        setup({select2: true});
    const form = new HTMLFormElement();
    const person = form.append(new HTMLSelectElement({tag: 'select', visible: false}));
    person.classes = ['select2-hidden-accessible'];
    person.select2Open = true;
    person.nextElementSibling = {classList: {contains: name => name === 'select2'}, getClientRects: () => [{}]};
    allSelect2.push(person);
    const remarks = form.append(new HTMLInputElement());
    select(person);
    assert.equal(timeouts.length, 0);
    assert.equal(remarks.focused, false);
});

test('several workflow Select2 handlers with the same order advance in DOM order', () => {
    const {HTMLInputElement, HTMLSelectElement, HTMLFormElement, press, select, timeouts, allSelect2} =
        setup({select2: true});
    const form = new HTMLFormElement();
    form.append(new HTMLInputElement({order: '120'}));
    const person1 = form.append(new HTMLSelectElement({tag: 'select', order: '130', visible: false}));
    const person2 = form.append(new HTMLSelectElement({tag: 'select', order: '130', visible: false}));
    for (const person of [person1, person2]) {
        person.classes = ['select2-hidden-accessible'];
        person.nextElementSibling = {classList: {contains: name => name === 'select2'}, getClientRects: () => [{}]};
        allSelect2.push(person);
    }
    const remarks = form.append(new HTMLInputElement({order: '140'}));
    person1.select2Open = true;
    const search = new HTMLInputElement({tagged: false});
    search.search = true;
    press(search);
    select(person1);
    timeouts.shift()();
    assert.equal(person2.select2Open, true);
    person1.select2Open = false;
    press(search);
    select(person2);
    timeouts.shift()();
    assert.equal(remarks.focused, true);
    assert.equal(form.submits, 0);
});

test('last workflow Select2 keyboard selection obeys the configured submit mode', () => {
    const {HTMLInputElement, HTMLSelectElement, HTMLFormElement, press, select, timeouts, allSelect2} =
        setup({select2: true});
    const form = new HTMLFormElement();
    form.endBehavior = 'submit';
    const person = form.append(new HTMLSelectElement({tag: 'select', visible: false}));
    person.classes = ['select2-hidden-accessible'];
    person.select2Open = true;
    person.nextElementSibling = {classList: {contains: name => name === 'select2'}, getClientRects: () => [{}]};
    allSelect2.push(person);
    const save = form.addButton();
    const search = new HTMLInputElement({tagged: false});
    search.search = true;
    press(search);
    select(person);
    timeouts.shift()();
    assert.equal(form.submits, 1);
    assert.equal(form.submitter, save);
});

test('focusing a tagged native select opens its picker automatically', () => {
    const {HTMLInputElement, HTMLSelectElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    const first = form.append(new HTMLInputElement());
    const fund = form.append(new HTMLSelectElement({tag: 'select'}));
    const last = form.append(new HTMLInputElement());
    press(first);
    assert.equal(fund.focused, true);
    assert.equal(fund.pickerCalls, 1);
    assert.equal(last.focused, false);
});

test('native select Enter confirms selection before moving to next tagged input', () => {
    const {HTMLSelectElement, HTMLInputElement, HTMLFormElement, press, keyUp, timeouts} = setup();
    const form = new HTMLFormElement();
    const fund = form.append(new HTMLSelectElement({tag: 'select'}));
    const appropriation = form.append(new HTMLSelectElement({tag: 'select'}));
    const last = form.append(new HTMLInputElement());
    fund.focus();
    assert.equal(fund.pickerCalls, 1);
    const event = press(fund);
    assert.equal(event.defaultPrevented, false);
    assert.equal(appropriation.focused, false);
    keyUp(fund);
    assert.equal(appropriation.focused, false);
    assert.equal(timeouts.length, 1);
    timeouts.shift()();
    assert.equal(appropriation.focused, true);
    assert.equal(appropriation.pickerCalls, 1);
    assert.equal(last.focused, false);
});

test('native select value change commits then advances without waiting for keyup', () => {
    const {HTMLSelectElement, HTMLInputElement, HTMLFormElement, press, change, keyUp, timeouts} = setup();
    const form = new HTMLFormElement();
    const fund = form.append(new HTMLSelectElement({tag: 'select'}));
    const last = form.append(new HTMLInputElement());
    fund.focus();
    press(fund);
    change(fund);
    keyUp(fund);
    assert.equal(timeouts.length, 1);
    timeouts.shift()();
    assert.equal(last.focused, true);
});

test('mouse and arrow-key select changes do not unexpectedly move focus', () => {
    const {HTMLSelectElement, HTMLInputElement, HTMLFormElement, change} = setup();
    const form = new HTMLFormElement();
    const fund = form.append(new HTMLSelectElement({tag: 'select'}));
    const next = form.append(new HTMLInputElement());
    fund.focus();
    change(fund);
    assert.equal(next.focused, false);
});

test('tagged native select without showPicker support retains browser behavior', () => {
    const {HTMLSelectElement, HTMLInputElement, HTMLFormElement, press} = setup();
    const form = new HTMLFormElement();
    const fund = form.append(new HTMLSelectElement({tag: 'select'}));
    const next = form.append(new HTMLInputElement());
    fund.pickerUnsupported = true;
    fund.focus();
    assert.equal(press(fund).defaultPrevented, false);
    assert.equal(next.focused, false);
});

test('focus on Select2 rendered selection opens dropdown automatically', () => {
    const {HTMLSelectElement, HTMLFormElement, focusIn, context} = setup({select2: true});
    const form = new HTMLFormElement();
    const program = form.append(new HTMLSelectElement({tag: 'select', visible: false}));
    program.classes = ['select2-hidden-accessible'];
    program.nextElementSibling = {
        classList: {contains: name => name === 'select2'},
        getClientRects: () => [{}],
    };
    const selection = new context.HTMLElement({tag: 'span', tagged: false});
    selection.widgetContainer = {previousElementSibling: program};
    focusIn(selection);
    assert.equal(program.select2Open, true);
});

test('closing Select2 does not immediately reopen via focus restoration', () => {
    const {HTMLSelectElement, HTMLFormElement, focusIn, select2Closing, select2Close, timeouts, context} = setup({select2: true});
    const form = new HTMLFormElement();
    const person = form.append(new HTMLSelectElement({tag: 'select', visible: false}));
    person.classes = ['select2-hidden-accessible'];
    person.nextElementSibling = {
        classList: {contains: name => name === 'select2'},
        getClientRects: () => [{}],
    };
    const selection = new context.HTMLElement({tag: 'span', tagged: false});
    selection.widgetContainer = {previousElementSibling: person};
    focusIn(selection);
    assert.equal(person.select2Open, true);
    person.select2Open = false;
    select2Closing(person);
    select2Close(person);
    focusIn(selection);
    assert.equal(person.select2Open, false);
    timeouts.shift()();
    focusIn(selection);
    assert.equal(person.select2Open, true);
});

test('untagged selects never trigger automatic dropdown opening', () => {
    const {HTMLSelectElement, HTMLFormElement, focusIn, context} = setup({select2: true});
    const form = new HTMLFormElement();
    const native = form.append(new HTMLSelectElement({tag: 'select', tagged: false}));
    native.focus();
    assert.equal(native.pickerCalls, undefined);
    const decorated = form.append(new HTMLSelectElement({tag: 'select', tagged: false, visible: false}));
    decorated.classes = ['select2-hidden-accessible'];
    decorated.nextElementSibling = {
        classList: {contains: name => name === 'select2'},
        getClientRects: () => [{}],
    };
    const selection = new context.HTMLElement({tag: 'span', tagged: false});
    selection.widgetContainer = {previousElementSibling: decorated};
    focusIn(selection);
    assert.equal(decorated.select2Open, false);
});
