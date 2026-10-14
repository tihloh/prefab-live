(() => {
    'use strict';

    const componentSelector = '[pf\\:component]';
    const loadingSelector = '[pf\\:loading]';
    const errorSelector = '[pf\\:error]';
    const requestState = new WeakMap();
    const errorState = new WeakMap();
    const debounceTimers = new WeakMap();

    const decodeSnapshot = (encoded) => {
        const value = encoded.replace(/-/g, '+').replace(/_/g, '/');
        const padded = value + '='.repeat((4 - value.length % 4) % 4);
        const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
    };

    const encodeSnapshot = (snapshot) => {
        const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
        let binary = '';
        bytes.forEach(byte => binary += String.fromCharCode(byte));
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    };

    const modelDirective = (element) => {
        if (!(element instanceof Element)) return null;

        for (const attribute of element.attributes) {
            if (attribute.name !== 'pf:model' && !attribute.name.startsWith('pf:model.')) continue;
            const modifiers = attribute.name === 'pf:model'
                ? []
                : attribute.name.slice('pf:model.'.length).split('.').filter(Boolean);
            return {path: attribute.value.trim(), modifiers};
        }

        return null;
    };

    const modelElements = (root) => Array.from(root.querySelectorAll('input,select,textarea'))
        .filter(element => modelDirective(element)?.path);

    // pf:format="money": formatted text for users, plain decimals for models.
    const moneyInput = element => element instanceof HTMLInputElement
        && element.getAttribute('pf:format') === 'money';
    const moneyRaw = value => {
        const text = String(value ?? '').replace(/[^0-9.]/g, '');
        const point = text.indexOf('.');
        const whole = (point < 0 ? text : text.slice(0,point)).replace(/^0+(?=\d)/, '');
        const decimals = point < 0 ? '' : text.slice(point+1).replace(/\./g,'').slice(0,2);
        return whole + (point < 0 ? '' : '.'+decimals);
    };
    const moneyDisplay = (value, complete = false) => {
        const raw = moneyRaw(value);
        if (!raw) return '';
        const parts = raw.split('.');
        const whole = (parts[0] || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return whole + (complete ? '.' + (parts[1] || '').padEnd(2,'0')
            : parts.length > 1 ? '.'+parts[1] : '');
    };
    const formatMoneyTyping = element => {
        const before = element.value.slice(0,element.selectionStart ?? element.value.length);
        const index = moneyRaw(before).length;
        element.value = moneyDisplay(element.value);
        let offset = 0, seen = 0;
        while (offset < element.value.length && seen < index) {
            if (/[0-9.]/.test(element.value[offset])) seen++;
            offset++;
        }
        if (document.activeElement === element) element.setSelectionRange(offset,offset);
    };

    const readValue = (element) => {
        if (moneyInput(element)) return moneyRaw(element.value);
        if (element instanceof HTMLInputElement) {
            if (element.type === 'checkbox') return element.checked;
            if (element.type === 'radio') return element.checked ? element.value : undefined;
        }

        if (element instanceof HTMLSelectElement && element.multiple) {
            return Array.from(element.selectedOptions).map(option => option.value);
        }

        return element.value;
    };

    const collectUpdates = (root) => {
        const updates = {};

        for (const element of modelElements(root)) {
            const directive = modelDirective(element);
            if (!directive?.path) continue;

            const value = readValue(element);
            if (value !== undefined) updates[directive.path] = value;
        }

        return updates;
    };

    const debounceDelay = (modifiers) => {
        const index = modifiers.indexOf('debounce');
        if (index < 0) return 0;
        const token = modifiers[index + 1] || '300ms';
        const match = token.match(/^(\d+)(ms)?$/i);
        return match ? Math.max(0, Number(match[1])) : 300;
    };

    const fieldLoadingMatches = (element, fields) => {
        const target = (element.getAttribute('pf:loading') || '').trim();
        return target === '' || fields.includes(target);
    };

    const setLoading = (root, active, fields = []) => {
        root.setAttribute('aria-busy', active ? 'true' : 'false');
        root.querySelectorAll(loadingSelector).forEach(element => {
            element.hidden = !(active && fieldLoadingMatches(element, fields));
        });
    };

    const getPath = (data, path) => {
        let value = data;
        for (const segment of path.split('.')) {
            if (!value || typeof value !== 'object' || !(segment in value)) return undefined;
            value = value[segment];
        }
        return value;
    };

    const setElementValue = (element, value) => {
        if (value === undefined) return;

        if (element instanceof HTMLInputElement) {
            if (element.type === 'checkbox') {
                element.checked = Boolean(value);
                return;
            }
            if (element.type === 'radio') {
                element.checked = String(value) === element.value;
                return;
            }
        }

        if (element instanceof HTMLSelectElement && element.multiple && Array.isArray(value)) {
            const selected = new Set(value.map(String));
            Array.from(element.options).forEach(option => option.selected = selected.has(option.value));
            return;
        }

        element.value = moneyInput(element) ? moneyDisplay(value,true) : value === null ? '' : String(value);
    };

    const syncModelValues = (root, snapshot) => {
        modelElements(root).forEach(element => {
            const directive = modelDirective(element);
            if (directive?.path) setElementValue(element, getPath(snapshot, directive.path));
        });
    };

    const restoreModelValues = (root, values, except = []) => {
        const excluded = new Set(except);

        modelElements(root).forEach(element => {
            const directive = modelDirective(element);
            const path = directive?.path;
            if (!path || excluded.has(path) || !(path in values)) return;
            setElementValue(element, values[path]);
        });
    };

    const errorEntries = (errors) => errors && typeof errors === 'object' ? errors : {};

    const formHasValidationErrors = (root, form) => {
        const errors = errorState.get(root) || {};

        return modelElements(form).some(element => {
            const field = modelDirective(element)?.path;
            return Boolean(field && Array.isArray(errors[field]) && errors[field].length);
        });
    };

    const syncSubmitState = (root) => {
        root.querySelectorAll('form[pf\\:submit]').forEach(form => {
            const blocked = formHasValidationErrors(root, form);

            form.querySelectorAll('button[type="submit"], input[type="submit"]').forEach(control => {
                if (!(control instanceof HTMLButtonElement || control instanceof HTMLInputElement)) return;

                if (blocked) {
                    if (!control.disabled) {
                        control.dataset.pfLiveValidationDisabled = '1';
                    }
                    control.disabled = true;
                    control.setAttribute('aria-disabled', 'true');
                    return;
                }

                if (control.dataset.pfLiveValidationDisabled === '1') {
                    control.disabled = false;
                    delete control.dataset.pfLiveValidationDisabled;
                    control.removeAttribute('aria-disabled');
                }
            });
        });
    };

    const focusFirstValidationError = (root, form) => {
        const errors = errorState.get(root) || {};

        const target = modelElements(form).find(element => {
            const field = modelDirective(element)?.path;
            return Boolean(field && Array.isArray(errors[field]) && errors[field].length);
        });

        if (!(target instanceof HTMLElement)) return;
        target.focus({preventScroll: false});
        target.scrollIntoView({behavior: 'smooth', block: 'center'});
    };

    const renderErrors = (root) => {
        const errors = errorState.get(root) || {};

        root.querySelectorAll(errorSelector).forEach(element => {
            const field = (element.getAttribute('pf:error') || '').trim();
            const messages = field && Array.isArray(errors[field]) ? errors[field] : [];
            element.textContent = messages[0] || '';
            element.hidden = messages.length === 0;
            if (!element.hasAttribute('aria-live')) element.setAttribute('aria-live', 'polite');
        });

        modelElements(root).forEach(element => {
            const field = modelDirective(element)?.path;
            if (!field) return;
            if (Array.isArray(errors[field]) && errors[field].length) {
                element.setAttribute('aria-invalid', 'true');
            } else {
                element.removeAttribute('aria-invalid');
            }
        });

        syncSubmitState(root);
    };

    const mergeErrors = (root, data, replace = false) => {
        const next = replace ? {} : {...(errorState.get(root) || {})};
        const validated = Array.isArray(data.validated) ? data.validated : [];

        validated.forEach(field => delete next[field]);
        Object.entries(errorEntries(data.errors)).forEach(([field, messages]) => {
            if (Array.isArray(messages) && messages.length) next[field] = messages;
        });

        errorState.set(root, next);
    };

    const focusIdentity = (element) => {
        if (!(element instanceof Element)) return null;
        const key = element.getAttribute('pf:key');
        if (key) return {type: 'key', value: key};
        const model = modelDirective(element)?.path;
        if (model) return {type: 'model', value: model};
        const name = element.getAttribute('name');
        if (name) return {type: 'name', value: name};
        if (element.id) return {type: 'id', value: element.id};
        return null;
    };

    const findByIdentity = (root, identity) => {
        if (!identity) return null;

        if (identity.type === 'model') {
            return modelElements(root).find(element => modelDirective(element)?.path === identity.value) || null;
        }

        const candidates = identity.type === 'key'
            ? root.querySelectorAll('[pf\\:key]')
            : identity.type === 'name'
                ? root.querySelectorAll('[name]')
                : root.querySelectorAll('[id]');

        return Array.from(candidates).find(element => {
            if (identity.type === 'key') return element.getAttribute('pf:key') === identity.value;
            if (identity.type === 'name') return element.getAttribute('name') === identity.value;
            return element.id === identity.value;
        }) || null;
    };

    // Select2 renders a separate focusable widget/search box, sometimes outside
    // the component (dropdownParent). Map keyboard focus back to its original select.
    const select2FocusedControl = (root, focused) => {
        if (!(focused instanceof Element)) return null;
        const widget = focused.closest('.select2-container');
        const select = widget?.previousElementSibling;
        if (select instanceof HTMLSelectElement && root.contains(select)) return select;
        if (!focused.matches('.select2-search__field') || typeof window.jQuery?.fn?.select2 !== 'function') {
            return null;
        }
        return Array.from(root.querySelectorAll('select.select2-hidden-accessible')).find(element =>
            window.jQuery(element).data('select2')?.isOpen?.()
        ) || null;
    };

    const replaceContentPreservingFocus = (
        root,
        html,
        snapshot,
        preserveValues = null,
        validatedFields = [],
    ) => {
        const focused = document.activeElement;
        const select2Focus = select2FocusedControl(root, focused);
        const active = select2Focus || (focused instanceof Element && root.contains(focused) ? focused : null);
        const identity = focusIdentity(active);
        const restoreOpenSelect2 = Boolean(select2Focus && focused?.matches?.('.select2-search__field'));
        const selection = active && 'selectionStart' in active
            ? [active.selectionStart, active.selectionEnd]
            : null;

        root.innerHTML = html;
        syncModelValues(root, snapshot);

        if (preserveValues && typeof preserveValues === 'object') {
            restoreModelValues(root, preserveValues, validatedFields);
        }

        const replacement = findByIdentity(root, identity);
        if (!(replacement instanceof HTMLElement)) return;

        if (select2Focus) {
            // The application initializes Select2 after prefab:live:updated.
            // Focus its rebuilt widget after that hook, not the detached search box.
            setTimeout(() => {
                const current = findByIdentity(root, identity);
                if (!(current instanceof HTMLSelectElement)) return;
                const widget = current.nextElementSibling;
                if (restoreOpenSelect2 && typeof window.jQuery?.fn?.select2 === 'function'
                    && current.classList.contains('select2-hidden-accessible')) {
                    const instance = window.jQuery(current).data('select2');
                    if (!instance?.isOpen?.()) window.jQuery(current).select2('open');
                } else {
                    (widget?.querySelector('.select2-selection') || current).focus({preventScroll: true});
                }
            }, 0);
            return;
        }

        replacement.focus({preventScroll: true});
        if (selection && 'setSelectionRange' in replacement) {
            const length = String(replacement.value ?? '').length;
            replacement.setSelectionRange(
                Math.min(selection[0] ?? length, length),
                Math.min(selection[1] ?? length, length),
            );
        }
    };

    const initializeRoot = (root) => {
        if (!(root instanceof Element)) return;
        if (!errorState.has(root)) errorState.set(root, {});
        setLoading(root, false);
        renderErrors(root);
        root.querySelectorAll('[pf\\:format="money"]').forEach(element => {
            if (moneyInput(element) && document.activeElement !== element) element.value = moneyDisplay(element.value,true);
        });
    };

    const request = async (root, options = {}) => {
        const state = requestState.get(root) || {sequence: 0, controller: null};
        state.sequence++;
        const sequence = state.sequence;
        state.controller?.abort();
        state.controller = new AbortController();
        requestState.set(root, state);

        const action = options.action || null;
        const fields = Array.isArray(options.validate) ? options.validate : [];
        const updates = options.updates || (action ? collectUpdates(root) : {});
        setLoading(root, true, fields);

        try {
            const endpoint = root.getAttribute('pf:endpoint') || '/prefab/live';
            const csrf = root.getAttribute('pf:csrf');
            const headers = {'Content-Type': 'application/json', 'Accept': 'application/json'};
            if (csrf) headers['X-CSRF-Token'] = csrf;

            const payload = {
                id: root.getAttribute('pf:id'),
                component: root.getAttribute('pf:component'),
                snapshot: decodeSnapshot(root.getAttribute('pf:snapshot') || ''),
                checksum: root.getAttribute('pf:checksum'),
                updates,
                validate: fields,
                action: action ? {method: action, params: []} : null,
            };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                credentials: 'same-origin',
                signal: state.controller.signal,
            });

            if (!response.ok) {
                throw new Error(`Prefab Live request failed with HTTP ${response.status}.`);
            }

            const data = await response.json();
            if (!data || typeof data.html !== 'string' || !data.snapshot || typeof data.checksum !== 'string') {
                throw new Error('Prefab Live received an invalid response.');
            }

            if ((requestState.get(root)?.sequence || 0) !== sequence) return;

            const browserValues = action ? null : collectUpdates(root);
            mergeErrors(root, data, Boolean(action));
            replaceContentPreservingFocus(
                root,
                data.html,
                data.snapshot,
                browserValues,
                fields,
            );
            root.setAttribute('pf:snapshot', encodeSnapshot(data.snapshot));
            root.setAttribute('pf:checksum', data.checksum);
            renderErrors(root);
            root.dispatchEvent(new CustomEvent('prefab:live:updated', {bubbles: true, detail: data}));
        } catch (error) {
            if (error?.name === 'AbortError') return;
            root.dispatchEvent(new CustomEvent('prefab:live:error', {bubbles: true, detail: {error}}));
            console.error(error);
        } finally {
            if ((requestState.get(root)?.sequence || 0) === sequence) {
                setLoading(root, false, fields);
            }
        }
    };

    const sendModel = (element) => {
        const directive = modelDirective(element);
        const root = element.closest(componentSelector);
        if (!directive?.path || !root) return;

        const value = readValue(element);
        if (value === undefined) return;

        request(root, {
            updates: collectUpdates(root),
            validate: [directive.path],
        });
    };

    const scheduleModel = (element) => {
        const directive = modelDirective(element);
        if (!directive) return;
        const delay = debounceDelay(directive.modifiers);

        const current = debounceTimers.get(element);
        if (current) clearTimeout(current);

        if (delay <= 0) {
            sendModel(element);
            return;
        }

        const timer = setTimeout(() => {
            debounceTimers.delete(element);
            sendModel(element);
        }, delay);
        debounceTimers.set(element, timer);
    };

    document.querySelectorAll(componentSelector).forEach(initializeRoot);


    // Opt-in Enter navigation. Only tagged, available controls in the same form participate.
    const enterSelector = 'input[pf\\:enter], select[pf\\:enter], textarea[pf\\:enter]';
    const isEnterControl = element => element instanceof HTMLInputElement
        || element instanceof HTMLSelectElement
        || element instanceof HTMLTextAreaElement;

    const select2Widget = element => {
        if (!(element instanceof HTMLSelectElement) || !element.classList.contains('select2-hidden-accessible')) return null;
        const widget = element.nextElementSibling;
        return widget?.classList.contains('select2') ? widget : null;
    };

    const availableEnterControl = element => {
        if (!isEnterControl(element) || !element.hasAttribute('pf:enter')) return false;
        if (element.matches(':disabled') || element.readOnly || element.closest('[hidden], [inert]')) return false;
        if (element instanceof HTMLInputElement
            && ['hidden', 'button', 'submit', 'reset', 'image', 'file'].includes(element.type)) return false;
        const visibleElement = select2Widget(element) || element;
        return visibleElement.getClientRects().length > 0;
    };

    const enterOrder = element => {
        const order = (element.getAttribute('pf:enter') || '').trim();
        return /^\d+$/.test(order) && Number.isSafeInteger(Number(order)) ? Number(order) : null;
    };

    const enterControls = form => Array.from(form.querySelectorAll(enterSelector))
        .filter(element => element.form === form && availableEnterControl(element))
        .map((element, index) => ({element, index, order: enterOrder(element)}))
        .sort((a, b) => {
            if (a.order !== null && b.order !== null) return a.order - b.order || a.index - b.index;
            if (a.order !== null) return -1;
            if (b.order !== null) return 1;
            return a.index - b.index;
        })
        .map(item => item.element);

    const focusEnterControl = element => {
        if (select2Widget(element) && typeof window.jQuery?.fn?.select2 === 'function') {
            window.jQuery(element).select2('open');
            return;
        }
        element.focus();
    };

    // A marked default button wins over the first enabled submit button.
    // This lets forms with multiple actions choose their keyboard default.
    const enterDefaultButton = form => {
        const buttons = Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"]'))
            .filter(button => !button.disabled && !button.closest('[hidden], [inert]')
                && button.getClientRects().length > 0);
        return buttons.find(button => button.hasAttribute('pf:enter-default'))
            || buttons.find(button => button.matches('button:not([type]), button[type="submit"], input[type="submit"]'))
            || null;
    };

    const enterSubmit = form => {
        const buttons = Array.from(form.querySelectorAll('button:not([type]), button[type="submit"], input[type="submit"]'));
        const preferred = enterDefaultButton(form);
        const submitter = preferred && preferred.matches('button:not([type]), button[type="submit"], input[type="submit"]')
            ? preferred
            : buttons.find(button => !button.disabled && !button.closest('[hidden], [inert]')
                && button.getClientRects().length > 0);
        if (submitter) form.requestSubmit(submitter);
        else if (!buttons.length) form.requestSubmit();
    };

    const enterEndBehavior = form => {
        const behavior = (form.getAttribute('pf:enter-end') || 'focus').trim().toLowerCase();
        return ['focus', 'submit', 'none'].includes(behavior) ? behavior : 'focus';
    };

    const handleEnterNavigation = event => {
        if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.keyCode === 229
            || event.repeat || event.shiftKey || event.altKey || event.metaKey) return;
        const control = event.target;
        if (!isEnterControl(control) || !availableEnterControl(control)) return;
        const form = control.form;
        const root = control.closest(componentSelector);
        if (!form || !root || !root.contains(form)) return;

        const controls = enterControls(form);
        const index = controls.indexOf(control);
        if (index < 0) return;

        event.preventDefault();
        if (event.ctrlKey) {
            // Ctrl+Enter requests a submit regardless of the configured end behavior.
            enterSubmit(form);
        } else if (index < controls.length - 1) {
            focusEnterControl(controls[index + 1]);
        } else {
            // Last tagged input: focus (default), submit, or suppress implicit submit.
            const behavior = enterEndBehavior(form);
            if (behavior === 'submit') enterSubmit(form);
            else if (behavior === 'focus') enterDefaultButton(form)?.focus();
        }
    };

    // Select2 consumes Enter in its own search box. Let it select/close first,
    // then advance only for keyboard selections (not mouse selections).
    let keyboardSelect2 = null;
    document.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.ctrlKey || event.altKey || event.shiftKey
            || event.metaKey || event.isComposing || event.keyCode === 229
            || !(event.target instanceof Element)
            || !event.target.matches('input.select2-search__field')
            || typeof window.jQuery?.fn?.select2 !== 'function') return;
        const selected = Array.from(document.querySelectorAll('select[pf\\:enter].select2-hidden-accessible'))
            .find(element => availableEnterControl(element)
                && element.closest(componentSelector)
                && window.jQuery(element).data('select2')?.isOpen?.());
        if (!selected) return;
        keyboardSelect2 = selected;
        // A Select2 keyboard selection is emitted synchronously from this keydown.
        Promise.resolve().then(() => {
            if (keyboardSelect2 === selected) keyboardSelect2 = null;
        });
    }, true);

    if (typeof window.jQuery?.fn?.select2 === 'function') {
        window.jQuery(document).on('select2:select.pfEnter', event => {
            const selected = event.target;
            if (selected !== keyboardSelect2) return;
            keyboardSelect2 = null;
            const root = selected.closest(componentSelector);
            const identity = focusIdentity(selected);
            setTimeout(() => {
                if (!root) return;
                // A live update may have replaced the original select already.
                const current = root.contains(selected) ? selected : findByIdentity(root, identity);
                if (!current || !availableEnterControl(current)) return;
                const form = current.form;
                if (!form) return;
                const controls = enterControls(form);
                const index = controls.indexOf(current);
                if (index < 0) return;
                if (index < controls.length - 1) {
                    focusEnterControl(controls[index + 1]);
                } else {
                    const behavior = enterEndBehavior(form);
                    if (behavior === 'submit') enterSubmit(form);
                    else if (behavior === 'focus') enterDefaultButton(form)?.focus();
                }
            }, 0);
        });
    }

    document.addEventListener('keydown', handleEnterNavigation);

    document.addEventListener('input', event => {
        const element = event.target instanceof Element ? event.target : null;
        if (moneyInput(element)) formatMoneyTyping(element);
        const directive = modelDirective(element);
        if (!directive || directive.modifiers.includes('blur')) return;
        if (!directive.modifiers.includes('live') && !directive.modifiers.includes('debounce')) return;
        scheduleModel(element);
    });

    document.addEventListener('change', event => {
        const element = event.target instanceof Element ? event.target : null;
        const directive = modelDirective(element);
        if (!directive || directive.modifiers.includes('blur')) return;
        if (!directive.modifiers.includes('live') && !directive.modifiers.includes('debounce')) return;

        if (element instanceof HTMLSelectElement
            || (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type))) {
            scheduleModel(element);
        }
    });

    document.addEventListener('focusout', event => {
        const element = event.target instanceof Element ? event.target : null;
        if (moneyInput(element)) element.value = moneyDisplay(element.value,true);
        const directive = modelDirective(element);
        if (!directive?.modifiers.includes('blur')) return;
        scheduleModel(element);
    });

    document.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target.closest('[pf\\:click]') : null;
        if (!target) return;

        const root = target.closest(componentSelector);
        const method = target.getAttribute('pf:click');
        if (!root || !method) return;

        event.preventDefault();
        request(root, {action: method});
    });

    document.addEventListener('submit', event => {
        const form = event.target instanceof HTMLFormElement ? event.target : null;
        if (!form || !form.hasAttribute('pf:submit')) return;

        const root = form.closest(componentSelector);
        const method = form.getAttribute('pf:submit');
        if (!root || !method) return;

        event.preventDefault();

        if (formHasValidationErrors(root, form)) {
            syncSubmitState(root);
            focusFirstValidationError(root, form);
            return;
        }

        request(root, {action: method});
    });

    new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (!(node instanceof Element)) return;
                if (node.matches(componentSelector)) initializeRoot(node);
                node.querySelectorAll?.(componentSelector).forEach(initializeRoot);
            });
        });
    }).observe(document.documentElement, {childList: true, subtree: true});
})();
